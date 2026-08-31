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
from dataclasses import dataclass, replace
from enum import Enum, unique
from typing import Final, Protocol, TypeAlias, runtime_checkable

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
    APPLIED = "applied"
    NO_CHANGE = "no-change"
    NAVIGATION = "navigation"
    CAPTURE = "capture"
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
            if (
                self.last_receipt.article_token != self.article_token
                or self.last_receipt.page_id not in roots_by_page
                or (
                    self.last_receipt.after_revision is not None
                    and self.last_receipt.after_revision > self.revision
                )
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


@runtime_checkable
class BrowserControlSession(Protocol):
    """One article-local observation and action executor capability."""

    def observe(self, *, page_state: BrowserPageState) -> BrowserObservation: ...

    def execute(
        self,
        action: BrowserAction,
        observation: BrowserObservation,
        *,
        timeout_seconds: float,
    ) -> BrowserActionReceipt: ...


def observation_hash(observation: BrowserObservation) -> Sha256:
    """Bind one model decision to the exact bounded observation bytes."""

    if not isinstance(observation, BrowserObservation):
        raise TypeError("observation must be BrowserObservation")
    digest = hashlib.sha256()
    digest.update(semantic_page_fingerprint(observation).root.encode("ascii"))
    digest.update(b"\0")
    digest.update(str(observation.revision).encode("ascii"))
    digest.update(b"\0")
    digest.update(observation.screenshot.screenshot_id.encode("ascii"))
    digest.update(b"\0")
    digest.update(observation.screenshot.sha256.root.encode("ascii"))
    return Sha256(digest.hexdigest())


def semantic_page_fingerprint(observation: BrowserObservation) -> Sha256:
    """Hash semantic page/surface/actionability facts, excluding revision and pixels."""

    if not isinstance(observation, BrowserObservation):
        raise TypeError("observation must be BrowserObservation")
    digest = hashlib.sha256()
    for value in (
        observation.article_token,
        observation.page_id,
        observation.page_state.value,
        observation.agent_status.value,
        observation.capture_state.value,
    ):
        digest.update(value.encode("utf-8"))
        digest.update(b"\0")
    for surface in observation.surfaces:
        values = (
            surface.surface_id,
            surface.page_id,
            surface.kind.value,
            surface.parent_surface_id or "",
            surface.origin,
            surface.path,
            surface.title,
            format(surface.bounds.x, ".17g"),
            format(surface.bounds.y, ".17g"),
            format(surface.bounds.width, ".17g"),
            format(surface.bounds.height, ".17g"),
            format(surface.scroll.x, ".17g"),
            format(surface.scroll.y, ".17g"),
            format(surface.scroll.maximum_x, ".17g"),
            format(surface.scroll.maximum_y, ".17g"),
        )
        for value in values:
            digest.update(value.encode("utf-8"))
            digest.update(b"\0")
    for element in observation.elements:
        for value in (
            element.element_id,
            element.surface_id,
            element.role,
            element.name,
            element.state.value,
            format(element.bounds.x, ".17g"),
            format(element.bounds.y, ".17g"),
            format(element.bounds.width, ".17g"),
            format(element.bounds.height, ".17g"),
        ):
            digest.update(value.encode("utf-8"))
            digest.update(b"\0")
    return Sha256(digest.hexdigest())


def action_fingerprint(action: BrowserAction) -> Sha256:
    """Hash one closed action without including a model or vendor fact."""

    if not isinstance(
        action, (ClickElement, ClickPoint, ScrollSurface, GoBack, WaitForChange, Stop)
    ):
        raise TypeError("action must be a closed Browser action")
    values: tuple[object, ...]
    if isinstance(action, ClickElement):
        values = (action.kind.value, action.page_id, action.surface_id, action.element_id)
    elif isinstance(action, ClickPoint):
        values = (
            action.kind.value,
            action.page_id,
            action.surface_id,
            action.screenshot_id,
            action.x,
            action.y,
        )
    elif isinstance(action, ScrollSurface):
        values = (action.kind.value, action.page_id, action.surface_id, action.delta_y)
    elif isinstance(action, Stop):
        values = (action.kind.value, action.page_id, action.reason or "")
    else:
        values = (action.kind.value, action.page_id)
    payload = "\0".join(str(value) for value in values).encode("utf-8")
    return sha256_digest(payload)


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

    def require_current(self, observation: BrowserObservation) -> BrowserObservation:
        current = self._current
        if (
            current is None
            or not isinstance(observation, BrowserObservation)
            or observation.revision != current.revision
            or observation.article_token != current.article_token
            or observation.page_id != current.page_id
            or observation_hash(observation) != observation_hash(current)
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
    "BrowserAction",
    "BrowserActionKind",
    "BrowserActionOutcome",
    "BrowserActionReceipt",
    "BrowserAgentStatus",
    "BrowserBounds",
    "BrowserCaptureState",
    "BrowserControlSession",
    "BrowserElement",
    "BrowserElementState",
    "BrowserObservation",
    "BrowserObservationLedger",
    "BrowserPageState",
    "BrowserScreenshot",
    "BrowserScrollState",
    "BrowserSurface",
    "BrowserSurfaceKind",
    "BrowserViewport",
    "ClickElement",
    "ClickPoint",
    "GoBack",
    "ScrollSurface",
    "Stop",
    "WaitForChange",
    "action_fingerprint",
    "observation_hash",
    "semantic_page_fingerprint",
)
