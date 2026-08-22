"""Bounded, request-local observations for the controlled Browser Agent.

The Network boundary is the only place that creates a Browser Agent
observation.  It intentionally contains no Playwright objects, selectors,
HTML, cookies, or complete query-bearing URLs.  An observation is a short lived
snapshot for one article flow; it is not a serialisable model or a persisted
fact.
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass, replace
from enum import Enum, unique
from typing import Final, Protocol, runtime_checkable

from sciretriever.model.primitives import Sha256

from .policy import PolicyError, normalize_url_with_configured_port

_ELEMENT_ID: Final[re.Pattern[str]] = re.compile(r"^e[0-9a-f]{1,32}$", re.ASCII)
_TOKEN: Final[re.Pattern[str]] = re.compile(r"^[a-z][a-z0-9._-]{0,63}$", re.ASCII)
_CONTROL: Final[re.Pattern[str]] = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_MAX_SCREENSHOT_BYTES: Final[int] = 2 * 1024 * 1024
_MAX_ELEMENTS: Final[int] = 64
_MAX_ELEMENT_NAME_BYTES: Final[int] = 256
_MAX_ROLE_BYTES: Final[int] = 64
_MAX_LOCATOR_BYTES: Final[int] = 8192
_MAX_PAGE_TOKEN_BYTES: Final[int] = 128


def _bounded_text(value: object, *, field_name: str, maximum: int) -> str:
    if type(value) is not str:
        raise TypeError(f"{field_name} must be text")
    candidate = value.strip()
    if not candidate or len(candidate.encode("utf-8")) > maximum or _CONTROL.search(candidate):
        raise ValueError(f"{field_name} must be bounded stable text")
    return candidate


def _finite_nonnegative(value: object, *, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{field_name} must be numeric")
    candidate = float(value)
    if not math.isfinite(candidate) or candidate < 0:
        raise ValueError(f"{field_name} must be finite and nonnegative")
    return candidate


def _query_free_locator(value: object) -> str:
    if type(value) is not str or len(value.encode("utf-8")) > _MAX_LOCATOR_BYTES:
        raise TypeError("locator must be bounded text")
    try:
        normalized = normalize_url_with_configured_port(value)
    except (PolicyError, TypeError, ValueError):
        raise ValueError("locator must be a safe HTTP(S) URL") from None
    if normalized.query:
        raise ValueError("locator must not contain query or fragment")
    return normalized.url


@unique
class BrowserElementState(str, Enum):
    """The closed state vocabulary exposed to the model."""

    VISIBLE_ENABLED = "visible-enabled"
    VISIBLE_DISABLED = "visible-disabled"
    HIDDEN_ENABLED = "hidden-enabled"
    HIDDEN_DISABLED = "hidden-disabled"

    @property
    def visible(self) -> bool:
        return self in {self.VISIBLE_ENABLED, self.VISIBLE_DISABLED}

    @property
    def enabled(self) -> bool:
        return self in {self.VISIBLE_ENABLED, self.HIDDEN_ENABLED}


@unique
class BrowserCaptureState(str, Enum):
    """Small capture fact used for deterministic Agent stopping."""

    NONE = "none"
    AVAILABLE = "available"
    CAPTURED = "captured"


@unique
class BrowserAgentActionKind(str, Enum):
    """Closed command kinds accepted by the Network Browser boundary."""

    CLICK_ELEMENT = "click-element"
    SCROLL_PAGE = "scroll-page"
    WAIT_FOR_PAGE = "wait-for-page"
    STOP_FLOW = "stop-flow"


@dataclass(frozen=True, slots=True, repr=False)
class BrowserAgentActionCommand:
    """Neutral action command after Acquisition validates a model decision."""

    kind: BrowserAgentActionKind
    revision: int
    element_id: str | None = None
    delta_y: int | None = None
    seconds: float | None = None
    reason: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.kind, BrowserAgentActionKind):
            raise TypeError("kind must be a BrowserAgentActionKind")
        if type(self.revision) is not int or self.revision < 1:
            raise ValueError("revision must be positive")
        fields = (self.element_id, self.delta_y, self.seconds, self.reason)
        if self.kind is BrowserAgentActionKind.CLICK_ELEMENT:
            if (
                type(self.element_id) is not str
                or _ELEMENT_ID.fullmatch(self.element_id) is None
                or any(value is not None for value in fields[1:])
            ):
                raise ValueError("click-element command is malformed")
        elif self.kind is BrowserAgentActionKind.SCROLL_PAGE:
            if (
                type(self.delta_y) is not int
                or self.delta_y == 0
                or abs(self.delta_y) > 2_000
                or self.element_id is not None
                or self.seconds is not None
                or self.reason is not None
            ):
                raise ValueError("scroll-page command is malformed")
        elif self.kind is BrowserAgentActionKind.WAIT_FOR_PAGE:
            if (
                isinstance(self.seconds, bool)
                or not isinstance(self.seconds, (int, float))
                or self.seconds < 0.05
                or self.seconds > 10.0
                or self.element_id is not None
                or self.delta_y is not None
                or self.reason is not None
            ):
                raise ValueError("wait-for-page command is malformed")
        elif any(value is not None for value in fields[:3]) or (
            self.reason is not None
            and (
                type(self.reason) is not str
                or not self.reason.strip()
                or len(self.reason.encode("utf-8")) > 128
            )
        ):
            raise ValueError("stop-flow command is malformed")

    def __repr__(self) -> str:
        return f"BrowserAgentActionCommand(kind={self.kind.value!r}, revision={self.revision})"


@runtime_checkable
class BrowserAgentActionPort(Protocol):
    """Capability-only request-local page action port."""

    def observe(self) -> BrowserAgentObservation: ...

    def execute(
        self,
        command: BrowserAgentActionCommand,
        observation: BrowserAgentObservation,
        *,
        timeout_seconds: float,
    ) -> None: ...


@dataclass(frozen=True, slots=True, repr=False)
class BrowserViewport:
    """Bounded viewport dimensions; pixels are never interpreted as a target."""

    width: int
    height: int

    def __post_init__(self) -> None:
        for field_name in ("width", "height"):
            value = getattr(self, field_name)
            if type(value) is not int or value < 1 or value > 16_384:
                raise ValueError(f"{field_name} must be a bounded positive integer")

    def __repr__(self) -> str:
        return f"BrowserViewport(width={self.width}, height={self.height})"


@dataclass(frozen=True, slots=True, repr=False)
class BrowserObservationBudget:
    """The remaining hard limits visible to one Agent turn."""

    remaining_steps: int
    remaining_seconds: float
    remaining_image_bytes: int
    remaining_navigations: int = 0

    def __post_init__(self) -> None:
        for field_name in (
            "remaining_steps",
            "remaining_image_bytes",
            "remaining_navigations",
        ):
            value = getattr(self, field_name)
            if type(value) is not int or value < 0:
                raise ValueError(f"{field_name} must be a nonnegative integer")
        object.__setattr__(
            self,
            "remaining_seconds",
            _finite_nonnegative(self.remaining_seconds, field_name="remaining_seconds"),
        )

    def __repr__(self) -> str:
        return (
            "BrowserObservationBudget("
            f"remaining_steps={self.remaining_steps}, "
            f"remaining_seconds={self.remaining_seconds:.3f}, "
            f"remaining_image_bytes={self.remaining_image_bytes}, "
            f"remaining_navigations={self.remaining_navigations})"
        )


@dataclass(frozen=True, slots=True, repr=False)
class BrowserElement:
    """One visible interaction affordance without a selector or DOM handle."""

    element_id: str
    role: str
    name: str
    state: BrowserElementState = BrowserElementState.VISIBLE_ENABLED

    def __post_init__(self) -> None:
        if type(self.element_id) is not str or _ELEMENT_ID.fullmatch(self.element_id) is None:
            raise ValueError("element_id must be a short opaque token")
        role = _bounded_text(self.role, field_name="role", maximum=_MAX_ROLE_BYTES)
        if _TOKEN.fullmatch(role.casefold()) is None:
            raise ValueError("role must be a stable lowercase token")
        object.__setattr__(self, "role", role.casefold())
        object.__setattr__(
            self,
            "name",
            _bounded_text(self.name, field_name="element name", maximum=_MAX_ELEMENT_NAME_BYTES),
        )
        if not isinstance(self.state, BrowserElementState):
            try:
                object.__setattr__(self, "state", BrowserElementState(self.state))
            except (TypeError, ValueError):
                raise ValueError("element state is not supported") from None

    @property
    def visible(self) -> bool:
        return self.state.visible

    @property
    def enabled(self) -> bool:
        return self.state.enabled

    def __repr__(self) -> str:
        return (
            "BrowserElement("
            f"element_id={self.element_id!r}, role={self.role!r}, "
            f"state={self.state.value!r})"
        )


@dataclass(frozen=True, slots=True, repr=False)
class BrowserAgentObservation:
    """A bounded page snapshot supplied to a Browser Agent turn.

    ``locator`` is normalised and query-free.  A short ``page_token`` is an
    operation-local identity only; it is never a URL or a Browser vendor id.
    ``revision`` changes whenever the page/navigation/DOM snapshot changes, so
    an element id from an earlier revision cannot be applied safely.
    """

    revision: int
    page_token: str
    locator: str
    status_code: int | None
    viewport: BrowserViewport
    screenshot: bytes | None
    screenshot_media_type: str | None
    elements: tuple[BrowserElement, ...]
    capture_state: BrowserCaptureState
    remaining_budget: BrowserObservationBudget

    def __post_init__(self) -> None:  # noqa: C901
        if type(self.revision) is not int or self.revision < 1:
            raise ValueError("revision must be a positive integer")
        page_token = _bounded_text(
            self.page_token,
            field_name="page_token",
            maximum=_MAX_PAGE_TOKEN_BYTES,
        )
        if _TOKEN.fullmatch(page_token.casefold()) is None:
            raise ValueError("page_token must be a stable opaque token")
        object.__setattr__(self, "page_token", page_token.casefold())
        object.__setattr__(self, "locator", _query_free_locator(self.locator))
        if self.status_code is not None and (
            type(self.status_code) is not int or not 100 <= self.status_code <= 599
        ):
            raise ValueError("status_code must be an HTTP status or None")
        if not isinstance(self.viewport, BrowserViewport):
            raise TypeError("viewport must be BrowserViewport")
        if self.screenshot is not None:
            if type(self.screenshot) is not bytes or not self.screenshot:
                raise ValueError("screenshot must be non-empty bytes")
            if len(self.screenshot) > _MAX_SCREENSHOT_BYTES:
                raise ValueError("screenshot exceeds the Browser Agent image budget")
            if self.screenshot_media_type not in {"image/png", "image/jpeg", "image/webp"}:
                raise ValueError("screenshot media type is unsupported")
        elif self.screenshot_media_type is not None:
            raise ValueError("screenshot media type requires screenshot bytes")
        if not isinstance(self.elements, tuple) or len(self.elements) > _MAX_ELEMENTS:
            raise ValueError("elements exceed the Browser Agent element budget")
        if any(not isinstance(element, BrowserElement) for element in self.elements):
            raise TypeError("elements must contain BrowserElement values")
        if len({element.element_id for element in self.elements}) != len(self.elements):
            raise ValueError("element ids must be unique within an observation")
        if not isinstance(self.capture_state, BrowserCaptureState):
            try:
                object.__setattr__(
                    self,
                    "capture_state",
                    BrowserCaptureState(self.capture_state),
                )
            except (TypeError, ValueError):
                raise ValueError("capture_state is not supported") from None
        if not isinstance(self.remaining_budget, BrowserObservationBudget):
            raise TypeError("remaining_budget must be BrowserObservationBudget")

    @property
    def origin(self) -> str:
        return normalize_url_with_configured_port(self.locator).origin.text

    @property
    def path(self) -> str:
        return normalize_url_with_configured_port(self.locator).path

    @property
    def budget(self) -> BrowserObservationBudget:
        """Alias used by controller code without duplicating the value."""

        return self.remaining_budget

    @property
    def actionable_elements(self) -> tuple[BrowserElement, ...]:
        return tuple(element for element in self.elements if element.visible and element.enabled)

    def with_revision(self, revision: int) -> BrowserAgentObservation:
        """Return the same bounded snapshot under a new DOM revision."""

        return replace(self, revision=revision)

    def __repr__(self) -> str:
        return (
            "BrowserAgentObservation("
            f"revision={self.revision}, page_token={self.page_token!r}, "
            f"origin={self.origin!r}, path={self.path!r}, status_code={self.status_code}, "
            f"viewport={self.viewport!r}, element_count={len(self.elements)}, "
            f"capture_state={self.capture_state.value!r}, "
            f"screenshot_bytes={0 if self.screenshot is None else len(self.screenshot)})"
        )

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("BrowserAgentObservation cannot be serialized")


def observation_hash(observation: BrowserAgentObservation) -> Sha256:
    """Hash only the bounded observation snapshot for request-local binding."""

    if not isinstance(observation, BrowserAgentObservation):
        raise TypeError("observation must be a BrowserAgentObservation")
    digest = hashlib.sha256()
    digest.update(str(observation.revision).encode("ascii"))
    digest.update(b"\0")
    for value in (
        observation.page_token,
        observation.locator,
        str(observation.status_code),
        str(observation.viewport.width),
        str(observation.viewport.height),
        observation.capture_state.value,
    ):
        digest.update(value.encode("utf-8"))
        digest.update(b"\0")
    for element in observation.elements:
        for value in (element.element_id, element.role, element.name, element.state.value):
            digest.update(value.encode("utf-8"))
            digest.update(b"\0")
    if observation.screenshot is not None:
        digest.update(observation.screenshot_media_type.encode("ascii"))
        digest.update(b"\0")
        digest.update(observation.screenshot)
    return Sha256(digest.hexdigest())


class BrowserObservationLedger:
    """Small in-memory revision ledger used by a single article page.

    The ledger never stores a page or vendor handle.  It only gives the Network
    adapter a deterministic way to invalidate element ids after navigation or
    a DOM update.
    """

    __slots__ = ("_current", "_next_revision")

    def __init__(self) -> None:
        self._current: BrowserAgentObservation | None = None
        self._next_revision = 1

    @property
    def current(self) -> BrowserAgentObservation | None:
        return self._current

    def publish(self, observation: BrowserAgentObservation) -> BrowserAgentObservation:
        if not isinstance(observation, BrowserAgentObservation):
            raise TypeError("observation must be a BrowserAgentObservation")
        current = observation.with_revision(self._next_revision)
        self._next_revision += 1
        self._current = current
        return current

    def invalidate(self) -> None:
        self._current = None
        self._next_revision += 1

    def replace_current(self, observation: BrowserAgentObservation) -> BrowserAgentObservation:
        """Refresh bounded bytes/budget without changing the DOM revision."""

        if not isinstance(observation, BrowserAgentObservation):
            raise TypeError("observation must be a BrowserAgentObservation")
        current = self._current
        if current is None or current.revision != observation.revision:
            raise ValueError("Browser Agent observation revision is stale")
        self._current = observation
        return observation

    def element(self, revision: int, element_id: str) -> BrowserElement:
        current = self._current
        if current is None or current.revision != revision:
            raise ValueError("Browser Agent observation revision is stale")
        if type(element_id) is not str:
            raise TypeError("element_id must be text")
        for element in current.elements:
            if element.element_id == element_id:
                return element
        raise ValueError("Browser Agent element id is not current")


__all__ = (
    "BrowserAgentActionCommand",
    "BrowserAgentActionKind",
    "BrowserAgentActionPort",
    "BrowserAgentObservation",
    "BrowserCaptureState",
    "BrowserElement",
    "BrowserElementState",
    "BrowserObservationBudget",
    "BrowserObservationLedger",
    "BrowserViewport",
    "observation_hash",
)
