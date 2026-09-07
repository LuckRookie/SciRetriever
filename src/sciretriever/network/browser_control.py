"""Request-local Browser observations and the six closed control actions.

Network is the only owner of these values.  They describe one in-memory
article session without exposing a Browser vendor object, selector, DOM
handle, cookie, query-bearing URL, or persistence contract.  Acquisition may
classify the current Publisher page and choose an action; only Network may
bind that action to the current revision and execute it.
"""

from __future__ import annotations

import hashlib
import math
import re
import time
from dataclasses import dataclass, replace
from enum import Enum, unique
from typing import Final, Protocol, TypeAlias, runtime_checkable

from sciretriever.model.access import AccessFailure
from sciretriever.model.primitives import Sha256, sha256_digest

from .policy import PolicyError, normalize_url_with_configured_port

_ARTICLE_TOKEN: Final[re.Pattern[str]] = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    re.ASCII,
)
_OPAQUE_ID: Final[re.Pattern[str]] = re.compile(r"^[a-z][0-9a-f]{8,64}$", re.ASCII)
_ROLE: Final[re.Pattern[str]] = re.compile(r"^[a-z][a-z0-9._-]{0,63}$", re.ASCII)
_CONTROL: Final[re.Pattern[str]] = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_MAX_TITLE_BYTES: Final[int] = 512
_MAX_ELEMENT_NAME_BYTES: Final[int] = 256
_MAX_SCREENSHOT_BYTES: Final[int] = 2 * 1024 * 1024
_MAX_SURFACES: Final[int] = 128
_MAX_ELEMENTS: Final[int] = 256
_MAX_SCROLL_PIXELS: Final[int] = 2_000
BROWSER_OBSERVATION_MEDIA_TYPE: Final[str] = "image/jpeg"


class BrowserObservationUnavailable(RuntimeError):
    """A document/page transition temporarily prevented a coherent snapshot.

    Concrete Browser adapters may raise this payload-free signal only for a
    transition that the article-local Network settle loop can safely observe
    again.  It must never carry a vendor exception, URL, selector, or page
    content across the adapter boundary.
    """

    __slots__ = ()

    def __init__(self) -> None:
        super().__init__("controlled Browser observation is transitioning")


def _article_token(value: object) -> str:
    if type(value) is not str:
        raise TypeError("article_token must be text")
    candidate = value.strip()
    if _ARTICLE_TOKEN.fullmatch(candidate) is None:
        raise ValueError("article_token must be a bounded operation-local token")
    return candidate


def _opaque_id(value: object, *, field_name: str) -> str:
    if type(value) is not str:
        raise TypeError(f"{field_name} must be text")
    candidate = value.strip().casefold()
    if _OPAQUE_ID.fullmatch(candidate) is None:
        raise ValueError(f"{field_name} must be an opaque request-local id")
    return candidate


def _bounded_text(
    value: object,
    *,
    field_name: str,
    maximum: int,
    allow_empty: bool = False,
) -> str:
    if type(value) is not str:
        raise TypeError(f"{field_name} must be text")
    candidate = value.strip()
    if (
        (not candidate and not allow_empty)
        or len(candidate.encode("utf-8")) > maximum
        or _CONTROL.search(candidate)
    ):
        raise ValueError(f"{field_name} must be bounded text")
    return candidate


def _finite(value: object, *, field_name: str, nonnegative: bool = True) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{field_name} must be numeric")
    candidate = float(value)
    if not math.isfinite(candidate) or (candidate < 0 if nonnegative else candidate <= 0):
        qualifier = "nonnegative" if nonnegative else "positive"
        raise ValueError(f"{field_name} must be finite and {qualifier}")
    return candidate


def _origin_and_path(origin: object, path: object) -> tuple[str, str]:
    if type(origin) is not str or type(path) is not str:
        raise TypeError("surface origin and path must be text")
    if "?" in path or "#" in path or not path.startswith("/"):
        raise ValueError("surface path must be absolute and query-free")
    try:
        normalized = normalize_url_with_configured_port(f"{origin}{path}")
    except (PolicyError, TypeError, ValueError):
        raise ValueError("surface location must be a safe HTTP(S) origin and path") from None
    if normalized.query:
        raise ValueError("surface location must be query-free")
    return normalized.origin.text, normalized.path


def _revision(value: object) -> int:
    if type(value) is not int or value < 1:
        raise ValueError("revision must be a positive integer")
    return value


@unique
class BrowserPageState(str, Enum):
    """The only page-state vocabulary shared by Rules and Agent modes."""

    NORMAL = "normal"
    CHALLENGE = "challenge"
    LOGIN_REQUIRED = "login-required"
    MFA_REQUIRED = "mfa-required"
    NOT_ENTITLED = "not-entitled"
    ACCESS_DENIED = "access-denied"
    NOT_FOUND = "not-found"
    FAILED = "failed"


@unique
class BrowserAgentStatus(str, Enum):
    """Operation-local status of the selected Browser Agent controller."""

    RUNNING = "running"
    STOPPED = "stopped"
    FAILED = "failed"


@unique
class BrowserCaptureState(str, Enum):
    """Independent capture progress for the current article session."""

    NONE = "none"
    CANDIDATE = "candidate"
    CAPTURED = "captured"


@unique
class BrowserSurfaceKind(str, Enum):
    """Closed kinds in one article-owned surface tree."""

    PAGE = "page"
    POPUP = "popup"
    FRAME = "frame"
    SHADOW = "shadow"
    VIEWER = "viewer"


@unique
class BrowserElementState(str, Enum):
    """All exposed elements are visible; state records actionability only."""

    ENABLED = "enabled"
    DISABLED = "disabled"

    @property
    def enabled(self) -> bool:
        return self is BrowserElementState.ENABLED


@unique
class BrowserActionKind(str, Enum):
    CLICK_ELEMENT = "click-element"
    CLICK_POINT = "click-point"
    SCROLL_SURFACE = "scroll-surface"
    GO_BACK = "go-back"
    WAIT_FOR_CHANGE = "wait-for-change"
    STOP = "stop"


@unique
class BrowserActionOutcome(str, Enum):
    """Outcome of dispatching one closed action, before page settlement."""

    APPLIED = "applied"
    NO_CHANGE = "no-change"
    FAILURE = "failure"


@dataclass(frozen=True, slots=True, repr=False)
class BrowserViewport:
    width: int
    height: int

    def __post_init__(self) -> None:
        for field_name in ("width", "height"):
            value = getattr(self, field_name)
            if type(value) is not int or not 1 <= value <= 16_384:
                raise ValueError(f"{field_name} must be a bounded positive integer")

    def __repr__(self) -> str:
        return f"BrowserViewport(width={self.width}, height={self.height})"


@dataclass(frozen=True, slots=True, repr=False)
class BrowserBounds:
    """Viewport-relative CSS-pixel bounds."""

    x: float
    y: float
    width: float
    height: float

    def __post_init__(self) -> None:
        object.__setattr__(self, "x", _finite(self.x, field_name="bounds x"))
        object.__setattr__(self, "y", _finite(self.y, field_name="bounds y"))
        object.__setattr__(
            self,
            "width",
            _finite(self.width, field_name="bounds width", nonnegative=False),
        )
        object.__setattr__(
            self,
            "height",
            _finite(self.height, field_name="bounds height", nonnegative=False),
        )

    def contains(self, x: float, y: float) -> bool:
        return self.x <= x <= self.x + self.width and self.y <= y <= self.y + self.height

    def __repr__(self) -> str:
        return (
            "BrowserBounds("
            f"x={self.x:.3f}, y={self.y:.3f}, width={self.width:.3f}, "
            f"height={self.height:.3f})"
        )


@dataclass(frozen=True, slots=True, repr=False)
class BrowserScrollState:
    x: float
    y: float
    maximum_x: float
    maximum_y: float

    def __post_init__(self) -> None:
        for field_name in ("x", "y", "maximum_x", "maximum_y"):
            object.__setattr__(
                self,
                field_name,
                _finite(getattr(self, field_name), field_name=f"scroll {field_name}"),
            )
        if self.x > self.maximum_x or self.y > self.maximum_y:
            raise ValueError("scroll position cannot exceed its maximum")


@dataclass(frozen=True, slots=True, repr=False)
class BrowserSurface:
    """One article-owned page, popup, frame, Shadow root, or viewer surface."""

    surface_id: str
    page_id: str
    kind: BrowserSurfaceKind
    parent_surface_id: str | None
    origin: str
    path: str
    title: str
    viewport: BrowserViewport
    bounds: BrowserBounds
    scroll: BrowserScrollState

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "surface_id",
            _opaque_id(self.surface_id, field_name="surface_id"),
        )
        object.__setattr__(self, "page_id", _opaque_id(self.page_id, field_name="page_id"))
        if not isinstance(self.kind, BrowserSurfaceKind):
            raise TypeError("kind must be BrowserSurfaceKind")
        if self.parent_surface_id is not None:
            object.__setattr__(
                self,
                "parent_surface_id",
                _opaque_id(self.parent_surface_id, field_name="parent_surface_id"),
            )
        if self.kind in {BrowserSurfaceKind.PAGE, BrowserSurfaceKind.POPUP}:
            if self.parent_surface_id is not None:
                raise ValueError("page and popup surfaces cannot have a parent")
        elif self.parent_surface_id is None:
            raise ValueError("nested surfaces require a parent")
        origin, path = _origin_and_path(self.origin, self.path)
        object.__setattr__(self, "origin", origin)
        object.__setattr__(self, "path", path)
        object.__setattr__(
            self,
            "title",
            _bounded_text(
                self.title,
                field_name="surface title",
                maximum=_MAX_TITLE_BYTES,
                allow_empty=True,
            ),
        )
        if not isinstance(self.viewport, BrowserViewport):
            raise TypeError("viewport must be BrowserViewport")
        if not isinstance(self.bounds, BrowserBounds):
            raise TypeError("bounds must be BrowserBounds")
        if not isinstance(self.scroll, BrowserScrollState):
            raise TypeError("scroll must be BrowserScrollState")
        if self.bounds.x + self.bounds.width > self.viewport.width or (
            self.bounds.y + self.bounds.height > self.viewport.height
        ):
            raise ValueError("surface bounds must fit the viewport")

    @property
    def locator(self) -> str:
        return f"{self.origin}{self.path}"


@dataclass(frozen=True, slots=True, repr=False)
class BrowserElement:
    """One visible element bound to a surface and current revision."""

    element_id: str
    surface_id: str
    role: str
    name: str
    state: BrowserElementState
    bounds: BrowserBounds

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "element_id",
            _opaque_id(self.element_id, field_name="element_id"),
        )
        object.__setattr__(
            self,
            "surface_id",
            _opaque_id(self.surface_id, field_name="surface_id"),
        )
        role = _bounded_text(self.role, field_name="role", maximum=64).casefold()
        if _ROLE.fullmatch(role) is None:
            raise ValueError("role must be a stable lowercase token")
        object.__setattr__(self, "role", role)
        object.__setattr__(
            self,
            "name",
            _bounded_text(
                self.name,
                field_name="element name",
                maximum=_MAX_ELEMENT_NAME_BYTES,
            ),
        )
        if not isinstance(self.state, BrowserElementState):
            raise TypeError("state must be BrowserElementState")
        if not isinstance(self.bounds, BrowserBounds):
            raise TypeError("bounds must be BrowserBounds")

    @property
    def enabled(self) -> bool:
        return self.state.enabled

    @property
    def visible(self) -> bool:
        return True

    def __repr__(self) -> str:
        return (
            "BrowserElement("
            f"element_id={self.element_id!r}, surface_id={self.surface_id!r}, "
            f"role={self.role!r}, state={self.state.value!r})"
        )


@dataclass(frozen=True, slots=True, repr=False)
class BrowserScreenshot:
    """One bounded viewport image bound to an exact article snapshot."""

    screenshot_id: str
    article_token: str
    page_id: str
    surface_id: str
    revision: int
    viewport: BrowserViewport
    media_type: str
    sha256: Sha256
    content: bytes

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "screenshot_id",
            _opaque_id(self.screenshot_id, field_name="screenshot_id"),
        )
        object.__setattr__(self, "article_token", _article_token(self.article_token))
        object.__setattr__(self, "page_id", _opaque_id(self.page_id, field_name="page_id"))
        object.__setattr__(
            self,
            "surface_id",
            _opaque_id(self.surface_id, field_name="surface_id"),
        )
        object.__setattr__(self, "revision", _revision(self.revision))
        if not isinstance(self.viewport, BrowserViewport):
            raise TypeError("viewport must be BrowserViewport")
        if self.media_type not in {"image/png", "image/jpeg", "image/webp"}:
            raise ValueError("screenshot media type is unsupported")
        if not isinstance(self.sha256, Sha256):
            raise TypeError("screenshot sha256 must be Sha256")
        if type(self.content) is not bytes or not self.content:
            raise ValueError("screenshot content must be non-empty bytes")
        if len(self.content) > _MAX_SCREENSHOT_BYTES:
            raise ValueError("screenshot exceeds the single-image byte limit")
        if sha256_digest(self.content) != self.sha256:
            raise ValueError("screenshot bytes do not match their hash")

    def __repr__(self) -> str:
        return (
            "BrowserScreenshot("
            f"screenshot_id={self.screenshot_id!r}, page_id={self.page_id!r}, "
            f"surface_id={self.surface_id!r}, revision={self.revision}, "
            f"media_type={self.media_type!r}, byte_size={len(self.content)})"
        )


@dataclass(frozen=True, slots=True, repr=False)
class BrowserActionReceipt:
    """Payload-free result of one Network-owned action execution."""

    action_kind: BrowserActionKind
    outcome: BrowserActionOutcome
    article_token: str
    page_id: str
    surface_id: str | None
    before_revision: int
    after_revision: int | None
    elapsed_milliseconds: int
    failure_code: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.action_kind, BrowserActionKind):
            raise TypeError("action_kind must be BrowserActionKind")
        if not isinstance(self.outcome, BrowserActionOutcome):
            raise TypeError("outcome must be BrowserActionOutcome")
        object.__setattr__(self, "article_token", _article_token(self.article_token))
        object.__setattr__(self, "page_id", _opaque_id(self.page_id, field_name="page_id"))
        if self.surface_id is not None:
            object.__setattr__(
                self,
                "surface_id",
                _opaque_id(self.surface_id, field_name="surface_id"),
            )
        object.__setattr__(self, "before_revision", _revision(self.before_revision))
        if self.after_revision is not None:
            object.__setattr__(self, "after_revision", _revision(self.after_revision))
            if self.after_revision < self.before_revision:
                raise ValueError("after_revision cannot precede before_revision")
        if type(self.elapsed_milliseconds) is not int or self.elapsed_milliseconds < 0:
            raise ValueError("elapsed_milliseconds must be nonnegative")
        if self.failure_code is not None:
            object.__setattr__(
                self,
                "failure_code",
                _bounded_text(
                    self.failure_code,
                    field_name="failure_code",
                    maximum=128,
                ),
            )
        if self.outcome is BrowserActionOutcome.FAILURE and self.failure_code is None:
            raise ValueError("failure receipt requires a failure_code")
        if self.outcome is not BrowserActionOutcome.FAILURE and self.failure_code is not None:
            raise ValueError("only failure receipts may carry a failure_code")


@dataclass(frozen=True, slots=True, repr=False)
class BrowserObservation:
    """One bounded unified snapshot for Rules or Agent control."""

    article_token: str
    revision: int
    page_id: str
    surfaces: tuple[BrowserSurface, ...]
    elements: tuple[BrowserElement, ...]
    screenshot: BrowserScreenshot
    page_state: BrowserPageState
    agent_status: BrowserAgentStatus
    capture_state: BrowserCaptureState
    last_receipt: BrowserActionReceipt | None = None

    def __post_init__(self) -> None:  # noqa: C901
        object.__setattr__(self, "article_token", _article_token(self.article_token))
        object.__setattr__(self, "revision", _revision(self.revision))
        object.__setattr__(self, "page_id", _opaque_id(self.page_id, field_name="page_id"))
        if not isinstance(self.surfaces, tuple) or not 1 <= len(self.surfaces) <= _MAX_SURFACES:
            raise ValueError("surfaces must be a bounded non-empty tuple")
        if any(not isinstance(value, BrowserSurface) for value in self.surfaces):
            raise TypeError("surfaces must contain BrowserSurface values")
        if not isinstance(self.elements, tuple) or len(self.elements) > _MAX_ELEMENTS:
            raise ValueError("elements exceed the observation limit")
        if any(not isinstance(value, BrowserElement) for value in self.elements):
            raise TypeError("elements must contain BrowserElement values")
        if not isinstance(self.screenshot, BrowserScreenshot):
            raise TypeError("screenshot must be BrowserScreenshot")
        for value, expected, name in (
            (self.page_state, BrowserPageState, "page_state"),
            (self.agent_status, BrowserAgentStatus, "agent_status"),
            (self.capture_state, BrowserCaptureState, "capture_state"),
        ):
            if not isinstance(value, expected):
                raise TypeError(f"{name} has an unsupported value")

        surface_by_id = {surface.surface_id: surface for surface in self.surfaces}
        if len(surface_by_id) != len(self.surfaces):
            raise ValueError("surface ids must be unique within a revision")
        roots_by_page: dict[str, int] = {}
        for surface in self.surfaces:
            if surface.parent_surface_id is None:
                roots_by_page[surface.page_id] = roots_by_page.get(surface.page_id, 0) + 1
            else:
                parent = surface_by_id.get(surface.parent_surface_id)
                if parent is None or parent.page_id != surface.page_id:
                    raise ValueError("surface parent must belong to the same page")
        if any(count != 1 for count in roots_by_page.values()) or self.page_id not in roots_by_page:
            raise ValueError("every observed page must have exactly one root surface")
        for surface in self.surfaces:
            seen = {surface.surface_id}
            parent_id = surface.parent_surface_id
            while parent_id is not None:
                if parent_id in seen:
                    raise ValueError("surface tree cannot contain a cycle")
                seen.add(parent_id)
                parent_id = surface_by_id[parent_id].parent_surface_id

        element_ids: set[str] = set()
        for element in self.elements:
            surface = surface_by_id.get(element.surface_id)
            if surface is None:
                raise ValueError("element surface is not current")
            if element.element_id in element_ids:
                raise ValueError("element ids must be unique within a revision")
            element_ids.add(element.element_id)
            center_x = element.bounds.x + element.bounds.width / 2
            center_y = element.bounds.y + element.bounds.height / 2
            if not surface.bounds.contains(center_x, center_y):
                raise ValueError("element bounds must belong to their surface")

        screenshot = self.screenshot
        if (
            screenshot.article_token != self.article_token
            or screenshot.page_id != self.page_id
            or screenshot.revision != self.revision
            or screenshot.surface_id not in surface_by_id
            or surface_by_id[screenshot.surface_id].page_id != self.page_id
        ):
            raise ValueError("screenshot identity is not aligned with the observation")
        if self.last_receipt is not None:
            if not isinstance(self.last_receipt, BrowserActionReceipt):
                raise TypeError("last_receipt must be BrowserActionReceipt or None")
            if self.last_receipt.article_token != self.article_token or (
                self.last_receipt.after_revision is not None
                and self.last_receipt.after_revision > self.revision
            ):
                raise ValueError("last receipt is not aligned with the observation")

    @property
    def primary_surface(self) -> BrowserSurface:
        return next(
            surface
            for surface in self.surfaces
            if surface.page_id == self.page_id and surface.parent_surface_id is None
        )

    @property
    def origin(self) -> str:
        return self.primary_surface.origin

    @property
    def path(self) -> str:
        return self.primary_surface.path

    @property
    def viewport(self) -> BrowserViewport:
        return self.screenshot.viewport

    @property
    def actionable_elements(self) -> tuple[BrowserElement, ...]:
        return tuple(element for element in self.elements if element.enabled)

    def with_revision(self, revision: int) -> BrowserObservation:
        """Return a provisional copy for ledger publication."""

        selected = _revision(revision)
        screenshot = replace(self.screenshot, revision=selected)
        return replace(self, revision=selected, screenshot=screenshot)

    def __repr__(self) -> str:
        return (
            "BrowserObservation("
            f"article_token={self.article_token!r}, revision={self.revision}, "
            f"page_id={self.page_id!r}, page_state={self.page_state.value!r}, "
            f"agent_status={self.agent_status.value!r}, "
            f"capture_state={self.capture_state.value!r}, "
            f"surface_count={len(self.surfaces)}, element_count={len(self.elements)}, "
            f"screenshot_bytes={len(self.screenshot.content)})"
        )

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("BrowserObservation cannot be serialized")


@unique
class BrowserTransitionKind(str, Enum):
    """Closed outcomes of validating, dispatching, and settling one action."""

    STALE = "stale"
    SETTLED = "settled"
    CAPTURED = "captured"
    CANDIDATE_TIMEOUT = "candidate-timeout"
    STOPPED = "stopped"
    CANCELLED = "cancelled"
    FAILED = "failed"


def _transition_receipt(
    receipt: BrowserActionReceipt | None,
    observation: BrowserObservation | None,
) -> None:
    if receipt is not None and not isinstance(receipt, BrowserActionReceipt):
        raise TypeError("receipt must be BrowserActionReceipt or None")
    if observation is not None and not isinstance(observation, BrowserObservation):
        raise TypeError("observation must be BrowserObservation or None")
    if receipt is not None and observation is not None:
        if (
            receipt.article_token != observation.article_token
            or receipt.after_revision is None
            or receipt.after_revision > observation.revision
        ):
            raise ValueError("transition receipt is not aligned with its observation")


@dataclass(frozen=True, slots=True, repr=False)
class BrowserStaleTransition:
    """The exact observation changed before dispatch; no vendor action ran."""

    observation: BrowserObservation

    def __post_init__(self) -> None:
        _transition_receipt(None, self.observation)

    @property
    def kind(self) -> BrowserTransitionKind:
        return BrowserTransitionKind.STALE


@dataclass(frozen=True, slots=True, repr=False)
class BrowserSettledTransition:
    """One dispatched action reached a bounded, observable settle point."""

    observation: BrowserObservation
    changed: bool
    receipt: BrowserActionReceipt | None = None

    def __post_init__(self) -> None:
        _transition_receipt(self.receipt, self.observation)
        if type(self.changed) is not bool:
            raise TypeError("changed must be a bool")
        if self.observation.capture_state is not BrowserCaptureState.NONE:
            raise ValueError("settled transition cannot retain capture progress")

    @property
    def kind(self) -> BrowserTransitionKind:
        return BrowserTransitionKind.SETTLED


@dataclass(frozen=True, slots=True, repr=False)
class BrowserCapturedTransition:
    """Network completed at least one bounded capture for this article flow."""

    observation: BrowserObservation
    receipt: BrowserActionReceipt | None = None

    def __post_init__(self) -> None:
        _transition_receipt(self.receipt, self.observation)
        if self.observation.capture_state is not BrowserCaptureState.CAPTURED:
            raise ValueError("captured transition requires a captured observation")

    @property
    def kind(self) -> BrowserTransitionKind:
        return BrowserTransitionKind.CAPTURED


@dataclass(frozen=True, slots=True, repr=False)
class BrowserCandidateTimeoutTransition:
    """A tentative capture did not complete or clear within its bounded wait."""

    observation: BrowserObservation
    receipt: BrowserActionReceipt | None = None

    def __post_init__(self) -> None:
        _transition_receipt(self.receipt, self.observation)
        if self.observation.capture_state is not BrowserCaptureState.CANDIDATE:
            raise ValueError("candidate timeout requires a candidate observation")

    @property
    def kind(self) -> BrowserTransitionKind:
        return BrowserTransitionKind.CANDIDATE_TIMEOUT


@dataclass(frozen=True, slots=True, repr=False)
class BrowserStoppedTransition:
    """The Agent selected Stop; Network performed no vendor action."""

    receipt: BrowserActionReceipt
    observation: BrowserObservation

    def __post_init__(self) -> None:
        _transition_receipt(self.receipt, self.observation)
        if self.receipt.action_kind is not BrowserActionKind.STOP:
            raise ValueError("stopped transition requires a Stop receipt")
        if self.observation.agent_status is not BrowserAgentStatus.STOPPED:
            raise ValueError("stopped transition requires a stopped observation")

    @property
    def kind(self) -> BrowserTransitionKind:
        return BrowserTransitionKind.STOPPED


@dataclass(frozen=True, slots=True, repr=False)
class BrowserCancelledTransition:
    """The user cancelled before a settled result crossed the boundary."""

    observation: BrowserObservation | None = None

    def __post_init__(self) -> None:
        _transition_receipt(None, self.observation)

    @property
    def kind(self) -> BrowserTransitionKind:
        return BrowserTransitionKind.CANCELLED


@dataclass(frozen=True, slots=True, repr=False)
class BrowserFailedTransition:
    """Network converted an action/runtime failure into a stable safe result."""

    failure: AccessFailure
    observation: BrowserObservation | None = None
    receipt: BrowserActionReceipt | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.failure, AccessFailure):
            raise TypeError("failure must be AccessFailure")
        _transition_receipt(self.receipt, self.observation)

    @property
    def kind(self) -> BrowserTransitionKind:
        return BrowserTransitionKind.FAILED


BrowserTransition: TypeAlias = (
    BrowserStaleTransition
    | BrowserSettledTransition
    | BrowserCapturedTransition
    | BrowserCandidateTimeoutTransition
    | BrowserStoppedTransition
    | BrowserCancelledTransition
    | BrowserFailedTransition
)


@dataclass(frozen=True, slots=True, repr=False)
class ClickElement:
    article_token: str
    page_id: str
    surface_id: str
    revision: int
    element_id: str

    def __post_init__(self) -> None:
        _set_action_identity(self)
        object.__setattr__(
            self,
            "element_id",
            _opaque_id(self.element_id, field_name="element_id"),
        )

    @property
    def kind(self) -> BrowserActionKind:
        return BrowserActionKind.CLICK_ELEMENT


@dataclass(frozen=True, slots=True, repr=False)
class ClickPoint:
    article_token: str
    page_id: str
    surface_id: str
    revision: int
    screenshot_id: str
    x: float
    y: float

    def __post_init__(self) -> None:
        _set_action_identity(self)
        object.__setattr__(
            self,
            "screenshot_id",
            _opaque_id(self.screenshot_id, field_name="screenshot_id"),
        )
        object.__setattr__(self, "x", _finite(self.x, field_name="point x"))
        object.__setattr__(self, "y", _finite(self.y, field_name="point y"))

    @property
    def kind(self) -> BrowserActionKind:
        return BrowserActionKind.CLICK_POINT


@dataclass(frozen=True, slots=True, repr=False)
class ScrollSurface:
    article_token: str
    page_id: str
    surface_id: str
    revision: int
    delta_y: int

    def __post_init__(self) -> None:
        _set_action_identity(self)
        if type(self.delta_y) is not int or self.delta_y == 0:
            raise ValueError("delta_y must be a nonzero integer")
        if abs(self.delta_y) > _MAX_SCROLL_PIXELS:
            raise ValueError("delta_y exceeds the bounded scroll range")

    @property
    def kind(self) -> BrowserActionKind:
        return BrowserActionKind.SCROLL_SURFACE


@dataclass(frozen=True, slots=True, repr=False)
class GoBack:
    article_token: str
    page_id: str
    revision: int

    def __post_init__(self) -> None:
        _set_page_action_identity(self)

    @property
    def kind(self) -> BrowserActionKind:
        return BrowserActionKind.GO_BACK

    @property
    def surface_id(self) -> None:
        return None


@dataclass(frozen=True, slots=True, repr=False)
class WaitForChange:
    article_token: str
    page_id: str
    revision: int

    def __post_init__(self) -> None:
        _set_page_action_identity(self)

    @property
    def kind(self) -> BrowserActionKind:
        return BrowserActionKind.WAIT_FOR_CHANGE

    @property
    def surface_id(self) -> None:
        return None


@dataclass(frozen=True, slots=True, repr=False)
class Stop:
    article_token: str
    page_id: str
    revision: int
    reason: str | None = None

    def __post_init__(self) -> None:
        _set_page_action_identity(self)
        if self.reason is not None:
            object.__setattr__(
                self,
                "reason",
                _bounded_text(self.reason, field_name="stop reason", maximum=128),
            )

    @property
    def kind(self) -> BrowserActionKind:
        return BrowserActionKind.STOP

    @property
    def surface_id(self) -> None:
        return None


BrowserAction: TypeAlias = ClickElement | ClickPoint | ScrollSurface | GoBack | WaitForChange | Stop


def _set_page_action_identity(action: GoBack | WaitForChange | Stop) -> None:
    object.__setattr__(action, "article_token", _article_token(action.article_token))
    object.__setattr__(action, "page_id", _opaque_id(action.page_id, field_name="page_id"))
    object.__setattr__(action, "revision", _revision(action.revision))


def _set_action_identity(action: ClickElement | ClickPoint | ScrollSurface) -> None:
    object.__setattr__(action, "article_token", _article_token(action.article_token))
    object.__setattr__(action, "page_id", _opaque_id(action.page_id, field_name="page_id"))
    object.__setattr__(
        action,
        "surface_id",
        _opaque_id(action.surface_id, field_name="surface_id"),
    )
    object.__setattr__(action, "revision", _revision(action.revision))


@dataclass(frozen=True, slots=True)
class BrowserStepAssessment:
    """Acquisition-owned page facts aligned with one Network observation."""

    page_state: BrowserPageState
    matches_observation: bool

    def __post_init__(self) -> None:
        if not isinstance(self.page_state, BrowserPageState):
            raise TypeError("page_state must be BrowserPageState")
        if type(self.matches_observation) is not bool:
            raise TypeError("matches_observation must be a bool")


@runtime_checkable
class BrowserStepPolicy(Protocol):
    """Classify one stable, neutral snapshot without owning its lifecycle."""

    def assess(self, observation: BrowserObservation) -> BrowserStepAssessment: ...


@runtime_checkable
class BrowserStepDriver(Protocol):
    """Network-private transition driver consumed by the atomic step session."""

    def begin(
        self,
        *,
        page_state: BrowserPageState,
        timeout_seconds: float,
    ) -> BrowserObservation | BrowserTransition: ...

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


@unique
class BrowserStepKind(str, Enum):
    """Stable outcomes allowed to cross the atomic Browser step boundary."""

    READY = "ready"
    CAPTURED = "captured"
    BLOCKED = "blocked"
    FAILED = "failed"
    CANCELLED = "cancelled"


@unique
class BrowserBlockedReason(str, Enum):
    """Payload-free natural stops, distinct from runtime or policy failures.

    The repeated-transition values are retained as readable result vocabulary
    for older serialized diagnostics, but the autonomous step session no
    longer manufactures them from an unchanged observation.  A no-change
    action is a normal settled step; the controller's bounded action/model
    budget is the only progress guard.
    """

    STOPPED = "stopped"
    CANDIDATE_TIMEOUT = "candidate-timeout"
    LOGIN_REQUIRED = "login-required"
    MFA_REQUIRED = "mfa-required"
    NOT_ENTITLED = "not-entitled"
    ACCESS_DENIED = "access-denied"
    NOT_FOUND = "not-found"
    PAGE_FAILED = "page-failed"
    REPEATED_SELF_TRANSITION = "repeated-self-transition"
    REPEATED_CYCLE_EDGE = "repeated-cycle-edge"


def _step_receipt(
    receipt: BrowserActionReceipt | None,
    observation: BrowserObservation | None,
) -> None:
    _transition_receipt(receipt, observation)


@dataclass(frozen=True, slots=True, repr=False)
class BrowserReady:
    """One stable observation and no unresolved capture candidate.

    ``page_state`` is descriptive input for the Agent, not an automatic
    terminal decision.  A login, entitlement, not-found or challenge page can
    still expose a visible control that the Agent may safely inspect or use;
    only the Agent's explicit ``Stop`` (or a hard runtime/timeout boundary)
    ends the session.
    """

    observation: BrowserObservation
    receipt: BrowserActionReceipt | None = None
    semantic_changed: bool = False

    def __post_init__(self) -> None:
        _step_receipt(self.receipt, self.observation)
        if self.observation.capture_state is not BrowserCaptureState.NONE:
            raise ValueError("ready step cannot retain capture progress")
        if type(self.semantic_changed) is not bool:
            raise TypeError("semantic_changed must be a bool")

    @property
    def kind(self) -> BrowserStepKind:
        return BrowserStepKind.READY


@dataclass(frozen=True, slots=True, repr=False)
class BrowserCaptured:
    """Network completed at least one capture for the current article."""

    observation: BrowserObservation
    receipt: BrowserActionReceipt | None = None
    semantic_changed: bool = False

    def __post_init__(self) -> None:
        _step_receipt(self.receipt, self.observation)
        if self.observation.capture_state is not BrowserCaptureState.CAPTURED:
            raise ValueError("captured step requires a captured observation")
        if type(self.semantic_changed) is not bool:
            raise TypeError("semantic_changed must be a bool")

    @property
    def kind(self) -> BrowserStepKind:
        return BrowserStepKind.CAPTURED


@dataclass(frozen=True, slots=True, repr=False)
class BrowserBlocked:
    """The settled page or controller reached one natural bounded stop."""

    reason: BrowserBlockedReason
    observation: BrowserObservation
    receipt: BrowserActionReceipt | None = None
    semantic_changed: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.reason, BrowserBlockedReason):
            raise TypeError("reason must be BrowserBlockedReason")
        _step_receipt(self.receipt, self.observation)
        if type(self.semantic_changed) is not bool:
            raise TypeError("semantic_changed must be a bool")
        expected_page_states: dict[BrowserBlockedReason, BrowserPageState] = {
            BrowserBlockedReason.LOGIN_REQUIRED: BrowserPageState.LOGIN_REQUIRED,
            BrowserBlockedReason.MFA_REQUIRED: BrowserPageState.MFA_REQUIRED,
            BrowserBlockedReason.NOT_ENTITLED: BrowserPageState.NOT_ENTITLED,
            BrowserBlockedReason.ACCESS_DENIED: BrowserPageState.ACCESS_DENIED,
            BrowserBlockedReason.NOT_FOUND: BrowserPageState.NOT_FOUND,
            BrowserBlockedReason.PAGE_FAILED: BrowserPageState.FAILED,
        }
        expected = expected_page_states.get(self.reason)
        if expected is not None and self.observation.page_state is not expected:
            raise ValueError("blocked reason does not match the page state")
        if (
            self.reason is BrowserBlockedReason.CANDIDATE_TIMEOUT
            and self.observation.capture_state is not BrowserCaptureState.CANDIDATE
        ):
            raise ValueError("candidate timeout requires a candidate observation")
        if self.reason is not BrowserBlockedReason.CANDIDATE_TIMEOUT and (
            self.observation.capture_state is not BrowserCaptureState.NONE
        ):
            raise ValueError("blocked step cannot retain capture progress")

    @property
    def kind(self) -> BrowserStepKind:
        return BrowserStepKind.BLOCKED


@dataclass(frozen=True, slots=True, repr=False)
class BrowserFailed:
    """Network or the injected policy failed before a stable result."""

    failure: AccessFailure
    observation: BrowserObservation | None = None
    receipt: BrowserActionReceipt | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.failure, AccessFailure):
            raise TypeError("failure must be AccessFailure")
        _step_receipt(self.receipt, self.observation)

    @property
    def kind(self) -> BrowserStepKind:
        return BrowserStepKind.FAILED


@dataclass(frozen=True, slots=True, repr=False)
class BrowserCancelled:
    """The user cancelled before another stable result crossed the boundary."""

    observation: BrowserObservation | None = None

    def __post_init__(self) -> None:
        _step_receipt(None, self.observation)

    @property
    def kind(self) -> BrowserStepKind:
        return BrowserStepKind.CANCELLED


BrowserStep: TypeAlias = (
    BrowserReady | BrowserCaptured | BrowserBlocked | BrowserFailed | BrowserCancelled
)


def _step_failure(kind: str) -> AccessFailure:
    values: dict[str, tuple[str, str, str, bool]] = {
        "readiness": (
            "acquisition-browser-readiness-timeout",
            "The Browser page did not reach one stable actionable observation.",
            "Retry after the Publisher page and Browser runtime become stable.",
            True,
        ),
        "policy": (
            "acquisition-browser-step-policy-failed",
            "The Browser page policy could not classify the stable observation.",
            "Review the Acquisition page classifier and Browser Debug transcript.",
            False,
        ),
    }
    code, reason, action, retryable = values.get(kind, values["policy"])
    return AccessFailure(code=code, reason=reason, action=action, retryable=retryable)


# Retained as a vocabulary map for consumers that classify a completed page
# outside the autonomous step session.  ``BrowserStepSession`` deliberately
# does not consult it: descriptive page states are delivered to the Agent,
# which owns the explicit stop decision.
_BLOCK_REASON_BY_PAGE_STATE: Final[dict[BrowserPageState, BrowserBlockedReason]] = {
    BrowserPageState.LOGIN_REQUIRED: BrowserBlockedReason.LOGIN_REQUIRED,
    BrowserPageState.MFA_REQUIRED: BrowserBlockedReason.MFA_REQUIRED,
    BrowserPageState.NOT_ENTITLED: BrowserBlockedReason.NOT_ENTITLED,
    BrowserPageState.ACCESS_DENIED: BrowserBlockedReason.ACCESS_DENIED,
    BrowserPageState.NOT_FOUND: BrowserBlockedReason.NOT_FOUND,
    BrowserPageState.FAILED: BrowserBlockedReason.PAGE_FAILED,
}


class BrowserStepSession:
    """Atomic article-local Browser session over one private transition driver.

    A caller may start once and may apply an action only while the last result
    is :class:`BrowserReady`.  Every call absorbs stale snapshots, Publisher
    classification races, page replacement, quiet settlement and capture
    candidates before returning one stable result.
    """

    __slots__ = (
        "_driver",
        "_policy",
        "_ready",
        "_started",
        "_terminal",
        "_timeout_seconds",
    )

    def __init__(
        self,
        *,
        driver: BrowserStepDriver,
        policy: BrowserStepPolicy,
        timeout_seconds: float,
    ) -> None:
        if not isinstance(driver, BrowserStepDriver):
            raise TypeError("driver must implement BrowserStepDriver")
        if not isinstance(policy, BrowserStepPolicy):
            raise TypeError("policy must implement BrowserStepPolicy")
        if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float)):
            raise TypeError("timeout_seconds must be numeric")
        selected_timeout = float(timeout_seconds)
        if not math.isfinite(selected_timeout) or selected_timeout <= 0:
            raise ValueError("timeout_seconds must be finite and positive")
        self._driver = driver
        self._policy = policy
        self._timeout_seconds = selected_timeout
        self._started = False
        self._terminal = False
        self._ready: BrowserObservation | None = None

    def start(self) -> BrowserStep:
        """Return the first stable step; this method is single-use."""

        if self._started:
            raise RuntimeError("BrowserStepSession.start() is single-use")
        self._started = True
        deadline = time.monotonic() + self._timeout_seconds
        initial = self._driver.begin(
            page_state=BrowserPageState.NORMAL,
            timeout_seconds=self._timeout_seconds,
        )
        if isinstance(initial, BrowserObservation):
            primed = self._prime_initial_observation(
                initial,
                deadline=deadline,
            )
            if isinstance(primed, BrowserFailed):
                return self._finish(primed)
            classified, assessment = primed
            transition = self._driver.settle(
                classified,
                timeout_seconds=self._remaining(deadline),
            )
            pending_assessment = (
                (classified, assessment)
                if assessment is not None and assessment.matches_observation
                else None
            )
        else:
            transition = initial
            pending_assessment = None
        return self._resolve(
            transition,
            deadline=deadline,
            baseline=None,
            pending_assessment=pending_assessment,
        )

    def _prime_initial_observation(
        self,
        observation: BrowserObservation,
        *,
        deadline: float,
    ) -> tuple[BrowserObservation, BrowserStepAssessment | None] | BrowserFailed:
        """Attach operation policy before the first capture/quiet wait."""

        try:
            assessment = self._policy.assess(observation)
        except BrowserObservationUnavailable:
            # The settle engine will reacquire a coherent successor and the
            # normal resolve loop will classify it before exposing Ready.
            return observation, None
        except Exception:
            return BrowserFailed(
                failure=_step_failure("policy"),
                observation=observation,
            )
        if not isinstance(assessment, BrowserStepAssessment):
            return BrowserFailed(
                failure=_step_failure("policy"),
                observation=observation,
            )
        if time.monotonic() >= deadline:
            return BrowserFailed(
                failure=_step_failure("readiness"),
                observation=observation,
            )
        return replace(observation, page_state=assessment.page_state), assessment

    def apply(self, action: BrowserAction) -> BrowserStep:
        """Validate, dispatch at most once, and return the next stable step."""

        if not self._started:
            raise RuntimeError("BrowserStepSession.start() must run before apply()")
        if self._terminal or self._ready is None:
            raise RuntimeError("BrowserStepSession cannot continue after a terminal result")
        if not isinstance(
            action,
            (ClickElement, ClickPoint, ScrollSurface, GoBack, WaitForChange, Stop),
        ):
            raise TypeError("action must be a closed Browser action")

        deadline = time.monotonic() + self._timeout_seconds
        previous = self._ready
        refresh = self._driver.settle(
            previous,
            timeout_seconds=self._remaining(deadline),
        )
        refreshed = self._resolve(refresh, deadline=deadline, baseline=previous)
        if not isinstance(refreshed, BrowserReady):
            return refreshed
        current = refreshed.observation
        if execution_binding_fingerprint(current) != execution_binding_fingerprint(previous):
            # A model or deterministic chooser acted on an observation that
            # changed while it was deciding.  No vendor action ran; the caller
            # receives the replacement Ready and must choose again.
            return refreshed

        transition = self._driver.execute(
            action,
            current,
            timeout_seconds=self._remaining(deadline),
        )
        result = self._resolve(transition, deadline=deadline, baseline=current)
        return result

    @staticmethod
    def _remaining(deadline: float) -> float:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            # The caller converts this bounded internal signal to one stable
            # failure; it never becomes a sleep/retry instruction upstream.
            return 0.000_001
        return remaining

    def _resolve(
        self,
        transition: BrowserTransition,
        *,
        deadline: float,
        baseline: BrowserObservation | None,
        pending_assessment: tuple[BrowserObservation, BrowserStepAssessment] | None = None,
    ) -> BrowserStep:
        receipt: BrowserActionReceipt | None = getattr(transition, "receipt", None)
        current_transition = transition
        stale_fingerprint: str | None = None
        while True:
            current_receipt = getattr(current_transition, "receipt", None)
            if receipt is None and isinstance(current_receipt, BrowserActionReceipt):
                receipt = current_receipt
            terminal = self._terminal_transition(
                current_transition,
                receipt=receipt,
                baseline=baseline,
            )
            if terminal is not None:
                return self._finish(terminal)
            if isinstance(current_transition, BrowserStaleTransition):
                fingerprint = stable_semantic_page_fingerprint(current_transition.observation).root
                if fingerprint == stale_fingerprint:
                    return self._finish(
                        BrowserFailed(
                            failure=_step_failure("readiness"),
                            observation=current_transition.observation,
                            receipt=receipt,
                        )
                    )
                stale_fingerprint = fingerprint
                if time.monotonic() >= deadline:
                    return self._finish(
                        BrowserFailed(
                            failure=_step_failure("readiness"),
                            observation=current_transition.observation,
                            receipt=receipt,
                        )
                    )
                current_transition = self._driver.settle(
                    current_transition.observation,
                    timeout_seconds=self._remaining(deadline),
                )
                continue
            if not isinstance(current_transition, BrowserSettledTransition):
                return self._finish(BrowserFailed(failure=_step_failure("policy")))

            stale_fingerprint = None
            settled = self._settled_successor(
                current_transition,
                deadline=deadline,
                baseline=baseline,
                receipt=receipt,
                pending_assessment=pending_assessment,
            )
            if isinstance(settled, tuple):
                current_transition, pending_assessment = settled
                continue
            return self._finish(settled)

    def _terminal_transition(
        self,
        transition: BrowserTransition,
        *,
        receipt: BrowserActionReceipt | None,
        baseline: BrowserObservation | None,
    ) -> BrowserStep | None:
        if isinstance(transition, BrowserCapturedTransition):
            return BrowserCaptured(
                observation=transition.observation,
                receipt=receipt,
                semantic_changed=self._semantic_changed(baseline, transition.observation),
            )
        if isinstance(transition, BrowserCandidateTimeoutTransition):
            # A candidate is an internal Browser capture concern.  A delayed
            # or unreadable response must not terminate Agent exploration: a
            # later native download event may still provide the bytes, or the
            # Agent may discover another visible download path.  Hide the
            # pending state from the next action while Network keeps it
            # operation-local for the final outcome.
            ready_observation = replace(
                transition.observation,
                capture_state=BrowserCaptureState.NONE,
            )
            return BrowserReady(
                observation=ready_observation,
                receipt=receipt,
                semantic_changed=self._semantic_changed(baseline, ready_observation),
            )
        if isinstance(transition, BrowserStoppedTransition):
            return BrowserBlocked(
                reason=BrowserBlockedReason.STOPPED,
                observation=transition.observation,
                receipt=receipt,
                semantic_changed=self._semantic_changed(baseline, transition.observation),
            )
        if isinstance(transition, BrowserCancelledTransition):
            return BrowserCancelled(transition.observation)
        if not isinstance(transition, BrowserFailedTransition):
            return None
        page_terminal = self._terminal_after_failure(
            transition,
            receipt=receipt,
            baseline=baseline,
        )
        return page_terminal or BrowserFailed(
            failure=transition.failure,
            observation=transition.observation,
            receipt=receipt,
        )

    def _settled_successor(
        self,
        transition: BrowserSettledTransition,
        *,
        deadline: float,
        baseline: BrowserObservation | None,
        receipt: BrowserActionReceipt | None,
        pending_assessment: tuple[BrowserObservation, BrowserStepAssessment] | None,
    ) -> (
        BrowserStep
        | tuple[
            BrowserTransition,
            tuple[BrowserObservation, BrowserStepAssessment] | None,
        ]
    ):
        observation = transition.observation
        assessment = self._reuse_assessment(pending_assessment, observation)
        if assessment is None:
            assessed = self._assess_policy(
                observation,
                deadline=deadline,
                receipt=receipt,
            )
            if isinstance(assessed, BrowserFailed):
                return assessed
            if assessed is None:
                return (
                    self._driver.settle(
                        observation,
                        timeout_seconds=self._remaining(deadline),
                    ),
                    None,
                )
            assessment = assessed
        classified = replace(observation, page_state=assessment.page_state)
        if not assessment.matches_observation:
            if time.monotonic() >= deadline:
                return BrowserFailed(
                    failure=_step_failure("readiness"),
                    observation=classified,
                    receipt=receipt,
                )
            # The policy could not bind its classification to this exact
            # observation, so reacquire before exposing it to the Agent.
            successor = self._driver.settle(
                classified,
                timeout_seconds=self._remaining(deadline),
            )
            return successor, None
        # ``page_state`` is descriptive Agent context, not a Browser state
        # transition.  Do not spend another settle cycle merely to attach a
        # challenge/login/access label to an otherwise coherent snapshot.
        return BrowserReady(
            observation=classified,
            receipt=receipt,
            semantic_changed=self._semantic_changed(baseline, classified),
        )

    def _assess_policy(
        self,
        observation: BrowserObservation,
        *,
        deadline: float,
        receipt: BrowserActionReceipt | None,
    ) -> BrowserStepAssessment | BrowserFailed | None:
        try:
            assessment = self._policy.assess(observation)
        except BrowserObservationUnavailable:
            if time.monotonic() < deadline:
                return None
            return BrowserFailed(
                failure=_step_failure("readiness"),
                observation=observation,
                receipt=receipt,
            )
        except Exception:
            return BrowserFailed(
                failure=_step_failure("policy"),
                observation=observation,
                receipt=receipt,
            )
        if isinstance(assessment, BrowserStepAssessment):
            return assessment
        return BrowserFailed(
            failure=_step_failure("policy"),
            observation=observation,
            receipt=receipt,
        )

    @staticmethod
    def _reuse_assessment(
        pending: tuple[BrowserObservation, BrowserStepAssessment] | None,
        observation: BrowserObservation,
    ) -> BrowserStepAssessment | None:
        if pending is None:
            return None
        expected, assessment = pending
        if stable_semantic_page_fingerprint(expected) != stable_semantic_page_fingerprint(
            observation
        ):
            return None
        return assessment

    def _terminal_after_failure(
        self,
        transition: BrowserFailedTransition,
        *,
        receipt: BrowserActionReceipt | None,
        baseline: BrowserObservation | None,
    ) -> BrowserBlocked | None:
        observation = transition.observation
        if (
            transition.failure.code != "acquisition-browser-agent-action-failed"
            or observation is None
        ):
            return None
        try:
            assessment = self._policy.assess(observation)
        except Exception:
            return None
        if not isinstance(assessment, BrowserStepAssessment):
            return None
        # A page classifier can describe a login, entitlement or not-found
        # state after a vendor action, but that description is not a terminal
        # decision.  The Agent must receive the stable observation and choose
        # whether to continue or explicitly stop.
        del receipt, baseline, assessment
        return None

    @staticmethod
    def _semantic_changed(
        before: BrowserObservation | None,
        after: BrowserObservation,
    ) -> bool:
        return before is not None and (
            stable_semantic_page_fingerprint(before) != stable_semantic_page_fingerprint(after)
        )

    def _finish(self, result: BrowserStep) -> BrowserStep:
        if isinstance(result, BrowserReady):
            self._ready = result.observation
            return result
        self._ready = None
        self._terminal = True
        return result


def execution_binding_fingerprint(observation: BrowserObservation) -> Sha256:
    """Bind a model decision to every exact request-local observation fact."""

    if not isinstance(observation, BrowserObservation):
        raise TypeError("observation must be BrowserObservation")
    digest = hashlib.sha256()
    exact_values: list[object] = [
        observation.article_token,
        observation.revision,
        observation.page_id,
        observation.page_state.value,
        observation.agent_status.value,
        observation.capture_state.value,
        observation.screenshot.screenshot_id,
        observation.screenshot.surface_id,
        observation.screenshot.media_type,
        observation.screenshot.sha256.root,
        observation.screenshot.viewport.width,
        observation.screenshot.viewport.height,
    ]
    for surface in observation.surfaces:
        exact_values.extend(
            (
                surface.surface_id,
                surface.page_id,
                surface.kind.value,
                surface.parent_surface_id or "",
                surface.origin,
                surface.path,
                surface.title,
                surface.bounds.x,
                surface.bounds.y,
                surface.bounds.width,
                surface.bounds.height,
                surface.scroll.x,
                surface.scroll.y,
                surface.scroll.maximum_x,
                surface.scroll.maximum_y,
            )
        )
    for element in observation.elements:
        exact_values.extend(
            (
                element.element_id,
                element.surface_id,
                element.role,
                element.name,
                element.state.value,
                element.bounds.x,
                element.bounds.y,
                element.bounds.width,
                element.bounds.height,
            )
        )
    receipt = observation.last_receipt
    if receipt is not None:
        exact_values.extend(
            (
                receipt.action_kind.value,
                receipt.outcome.value,
                receipt.article_token,
                receipt.page_id,
                receipt.surface_id or "",
                receipt.before_revision,
                receipt.after_revision or 0,
                receipt.failure_code or "",
            )
        )
    for value in exact_values:
        digest.update(str(value).encode("utf-8"))
        digest.update(b"\0")
    return Sha256(digest.hexdigest())


def _normalized_text(value: str) -> str:
    return " ".join(value.casefold().split())


def _position_bucket(value: float, extent: float, *, buckets: int = 32) -> int:
    if extent <= 0:
        return 0
    ratio = min(max(value / extent, 0.0), 1.0)
    return min(int(ratio * buckets), buckets - 1)


def _surface_semantic_key(surface: BrowserSurface) -> tuple[object, ...]:
    return (
        surface.kind.value,
        surface.origin,
        surface.path,
        _normalized_text(surface.title),
        _position_bucket(surface.bounds.x, surface.viewport.width),
        _position_bucket(surface.bounds.y, surface.viewport.height),
        _position_bucket(surface.bounds.width, surface.viewport.width),
        _position_bucket(surface.bounds.height, surface.viewport.height),
        _position_bucket(surface.scroll.x, max(surface.scroll.maximum_x, 1.0), buckets=16),
        _position_bucket(surface.scroll.y, max(surface.scroll.maximum_y, 1.0), buckets=16),
    )


def stable_semantic_page_fingerprint(observation: BrowserObservation) -> Sha256:
    """Hash stable page/actionability facts, excluding request-local bindings."""

    if not isinstance(observation, BrowserObservation):
        raise TypeError("observation must be BrowserObservation")
    digest = hashlib.sha256()
    for value in (observation.page_state.value,):
        digest.update(value.encode("utf-8"))
        digest.update(b"\0")
    surface_keys = {
        surface.surface_id: _surface_semantic_key(surface) for surface in observation.surfaces
    }
    for values in sorted(surface_keys.values(), key=repr):
        for value in values:
            digest.update(repr(value).encode("utf-8"))
            digest.update(b"\0")
    element_values: list[tuple[object, ...]] = []
    for element in observation.elements:
        surface = next(
            value for value in observation.surfaces if value.surface_id == element.surface_id
        )
        element_values.append(
            (
                surface_keys[element.surface_id],
                element.role,
                _normalized_text(element.name),
                element.state.value,
                _position_bucket(element.bounds.x, surface.viewport.width),
                _position_bucket(element.bounds.y, surface.viewport.height),
                _position_bucket(element.bounds.width, surface.viewport.width),
                _position_bucket(element.bounds.height, surface.viewport.height),
            )
        )
    for values in sorted(element_values, key=repr):
        for value in values:
            digest.update(repr(value).encode("utf-8"))
            digest.update(b"\0")
    return Sha256(digest.hexdigest())


def stable_action_intent_fingerprint(
    action: BrowserAction,
    observation: BrowserObservation,
) -> Sha256:
    """Hash an action's stable intent without revision or opaque target ids."""

    if not isinstance(observation, BrowserObservation):
        raise TypeError("observation must be BrowserObservation")
    if not isinstance(
        action, (ClickElement, ClickPoint, ScrollSurface, GoBack, WaitForChange, Stop)
    ):
        raise TypeError("action must be a closed Browser action")
    values: tuple[object, ...]
    if isinstance(action, ClickElement):
        element = next(
            (value for value in observation.elements if value.element_id == action.element_id),
            None,
        )
        surface = next(
            (value for value in observation.surfaces if value.surface_id == action.surface_id),
            None,
        )
        if element is None or surface is None or element.surface_id != surface.surface_id:
            raise ValueError("click element intent is not bound to the observation")
        values = (
            action.kind.value,
            _surface_semantic_key(surface),
            element.role,
            _normalized_text(element.name),
            element.state.value,
            _position_bucket(element.bounds.x, surface.viewport.width),
            _position_bucket(element.bounds.y, surface.viewport.height),
        )
    elif isinstance(action, ClickPoint):
        surface = next(
            (value for value in observation.surfaces if value.surface_id == action.surface_id),
            None,
        )
        if surface is None or not surface.bounds.contains(action.x, action.y):
            raise ValueError("click point intent is not bound to the observation")
        values = (
            action.kind.value,
            _surface_semantic_key(surface),
            _position_bucket(action.x - surface.bounds.x, surface.bounds.width),
            _position_bucket(action.y - surface.bounds.y, surface.bounds.height),
        )
    elif isinstance(action, ScrollSurface):
        surface = next(
            (value for value in observation.surfaces if value.surface_id == action.surface_id),
            None,
        )
        if surface is None:
            raise ValueError("scroll intent is not bound to the observation")
        magnitude = abs(action.delta_y)
        magnitude_class = (
            "small" if magnitude <= 400 else "medium" if magnitude <= 1_000 else "large"
        )
        values = (
            action.kind.value,
            _surface_semantic_key(surface),
            "down" if action.delta_y > 0 else "up",
            magnitude_class,
        )
    elif isinstance(action, Stop):
        values = (action.kind.value, action.reason or "")
    else:
        values = (action.kind.value,)
    return sha256_digest(repr(values).encode("utf-8"))


class BrowserObservationLedger:
    """Article-local revision ledger containing no Browser vendor object."""

    __slots__ = ("_current", "_next_revision")

    def __init__(self) -> None:
        self._current: BrowserObservation | None = None
        self._next_revision = 1

    @property
    def current(self) -> BrowserObservation | None:
        return self._current

    def publish(self, observation: BrowserObservation) -> BrowserObservation:
        if not isinstance(observation, BrowserObservation):
            raise TypeError("observation must be BrowserObservation")
        current = observation.with_revision(self._next_revision)
        self._next_revision += 1
        self._current = current
        return current

    def invalidate(self) -> None:
        self._current = None

    def replace_current(self, observation: BrowserObservation) -> BrowserObservation:
        if not isinstance(observation, BrowserObservation):
            raise TypeError("observation must be BrowserObservation")
        current = self._current
        if current is None or current.revision != observation.revision:
            raise ValueError("Browser observation revision is stale")
        self._current = observation
        return observation

    def restore_current(self, observation: BrowserObservation) -> BrowserObservation:
        """Restore a coherent snapshot after a vendor action invalidated it.

        Network may complete a capture while the action ledger is invalidated
        and a fresh vendor snapshot is temporarily unavailable. The last
        coherent observation is still sufficient for a subsequent closed
        action, so restoring it must not allocate a new revision or require a
        second Browser call.
        """

        if not isinstance(observation, BrowserObservation):
            raise TypeError("Browser observation must be current")
        current = self._current
        if current is not None and current.revision != observation.revision:
            raise ValueError("Browser observation revision is stale")
        self._current = observation
        self._next_revision = max(self._next_revision, observation.revision + 1)
        return observation

    def require_current(self, observation: BrowserObservation) -> BrowserObservation:
        current = self._current
        if (
            current is None
            or not isinstance(observation, BrowserObservation)
            or observation.revision != current.revision
            or observation.article_token != current.article_token
            or observation.page_id != current.page_id
            or execution_binding_fingerprint(observation) != execution_binding_fingerprint(current)
        ):
            raise ValueError("Browser observation is not current")
        return current

    def element(self, observation: BrowserObservation, element_id: str) -> BrowserElement:
        current = self.require_current(observation)
        selected = _opaque_id(element_id, field_name="element_id")
        for element in current.elements:
            if element.element_id == selected:
                return element
        raise ValueError("Browser element id is not current")

    def surface(self, observation: BrowserObservation, surface_id: str) -> BrowserSurface:
        current = self.require_current(observation)
        selected = _opaque_id(surface_id, field_name="surface_id")
        for surface in current.surfaces:
            if surface.surface_id == selected:
                return surface
        raise ValueError("Browser surface id is not current")


__all__ = (
    "BROWSER_OBSERVATION_MEDIA_TYPE",
    "BrowserAction",
    "BrowserActionKind",
    "BrowserActionOutcome",
    "BrowserActionReceipt",
    "BrowserAgentStatus",
    "BrowserBlocked",
    "BrowserBlockedReason",
    "BrowserBounds",
    "BrowserCancelled",
    "BrowserCaptured",
    "BrowserCaptureState",
    "BrowserElement",
    "BrowserElementState",
    "BrowserFailed",
    "BrowserObservation",
    "BrowserObservationUnavailable",
    "BrowserPageState",
    "BrowserReady",
    "BrowserScreenshot",
    "BrowserScrollState",
    "BrowserStep",
    "BrowserStepAssessment",
    "BrowserStepKind",
    "BrowserStepPolicy",
    "BrowserStepSession",
    "BrowserSurface",
    "BrowserSurfaceKind",
    "BrowserViewport",
    "ClickElement",
    "ClickPoint",
    "GoBack",
    "ScrollSurface",
    "Stop",
    "WaitForChange",
    "execution_binding_fingerprint",
    "stable_action_intent_fingerprint",
    "stable_semantic_page_fingerprint",
)
