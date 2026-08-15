"""Local declarative rules for controlled Browser acquisition.

Rules in this module are deliberately small, immutable, and executable only
through the fixed observations and operations understood by
:mod:`acquisition.sources.browser`.  Page markers may use reviewed static CSS
selectors, exact-origin URL path prefixes, and response statuses.  They are
not a remote rule language: there is no loader, JavaScript surface, login form
description, Cookie/profile data, selector guessing, or fallback action
sequence.

The production catalog is intentionally empty.  Network now accepts a closed
destination guard and enforces it before every external Browser request;
provider rules remain disabled until their page states, sessions, scheduling,
capture paths and offline fixtures are verified end to end.
"""

from __future__ import annotations

import hashlib
import ipaddress
import re
from dataclasses import dataclass, field
from enum import Enum, unique
from typing import Final

from sciretriever.model.access import BrowserCaptureKind
from sciretriever.model.primitives import Sha256
from sciretriever.network.browser import BrowserPageObservation
from sciretriever.network.policy import (
    NormalizedURL,
    PolicyError,
    normalize_url_with_configured_port,
)

_RULE_TOKEN: Final[re.Pattern[str]] = re.compile(
    r"[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?",
    re.ASCII,
)
_CONTROL_CHARACTER: Final[re.Pattern[str]] = re.compile(r"[\x00-\x1f\x7f]")
_FORBIDDEN_SELECTOR_MARKERS: Final[tuple[str, ...]] = (
    "javascript:",
    "xpath=",
    "text=",
    "role=",
    "url(",
    ">>",
    "${",
    "{{",
    "`",
    "{",
    "}",
    ";",
)
_MAX_MARKERS: Final[int] = 8
_MAX_PAGE_MARKERS: Final[int] = 32
_MAX_ACTIONS: Final[int] = 8


def _stable_token(value: object, *, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    candidate = value.strip().casefold()
    if _RULE_TOKEN.fullmatch(candidate) is None:
        raise ValueError(f"{field_name} must be a stable lowercase token")
    return candidate


def _exact_https_origin(value: object, *, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    try:
        normalized = normalize_url_with_configured_port(value)
    except (PolicyError, TypeError, ValueError):
        raise ValueError(f"{field_name} must be an exact HTTPS origin") from None
    if normalized.scheme != "https" or normalized.path != "/" or normalized.query:
        raise ValueError(f"{field_name} must be an exact HTTPS origin")
    try:
        ipaddress.ip_address(normalized.hostname)
    except ValueError:
        pass
    else:
        raise ValueError(f"{field_name} must identify an exact DNS domain")
    return normalized.origin.text


def _static_selector(value: object, *, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    candidate = value.strip()
    folded = candidate.casefold()
    if (
        not candidate
        or len(candidate) > 512
        or _CONTROL_CHARACTER.search(candidate) is not None
        or "://" in candidate
        or any(marker in folded for marker in _FORBIDDEN_SELECTOR_MARKERS)
    ):
        raise ValueError(f"{field_name} must be one static CSS selector")
    return candidate


def _markers(value: object, *, field_name: str) -> tuple[str, ...]:
    if not isinstance(value, tuple):
        raise TypeError(f"{field_name} must be a tuple")
    if len(value) > _MAX_MARKERS:
        raise ValueError(f"{field_name} contains too many markers")
    result = tuple(_static_selector(item, field_name=field_name) for item in value)
    if len(set(result)) != len(result):
        raise ValueError(f"{field_name} must not contain duplicates")
    return result


def _url_prefixes(value: object) -> tuple[str, ...]:
    if not isinstance(value, tuple):
        raise TypeError("url_prefixes must be a tuple")
    if len(value) > _MAX_MARKERS:
        raise ValueError("url_prefixes contains too many markers")
    result = []
    for item in value:
        normalized = _normalized_url(item)
        if normalized.scheme != "https" or normalized.query or normalized.path == "/":
            raise ValueError("url_prefixes must contain query-free HTTPS path prefixes")
        result.append(normalized.url)
    if len(set(result)) != len(result):
        raise ValueError("url_prefixes must not contain duplicates")
    return tuple(result)


def _status_codes(value: object) -> tuple[int, ...]:
    if not isinstance(value, tuple):
        raise TypeError("response_statuses must be a tuple")
    if len(value) > _MAX_MARKERS:
        raise ValueError("response_statuses contains too many markers")
    if any(type(item) is not int or not 100 <= item <= 599 for item in value):
        raise ValueError("response_statuses must contain HTTP status codes")
    if len(set(value)) != len(value):
        raise ValueError("response_statuses must not contain duplicates")
    return value


def _rule_origins(
    landing_value: object,
    allowed_value: object,
) -> tuple[str, tuple[str, ...]]:
    landing_origin = _exact_https_origin(landing_value, field_name="landing_origin")
    if not isinstance(allowed_value, tuple):
        raise TypeError("allowed_origins must be a tuple")
    allowed_origins = tuple(
        _exact_https_origin(item, field_name="allowed_origins") for item in allowed_value
    )
    if not allowed_origins:
        raise ValueError("allowed_origins must not be empty")
    if len(set(allowed_origins)) != len(allowed_origins):
        raise ValueError("allowed_origins must not contain duplicates")
    if landing_origin not in allowed_origins:
        raise ValueError("allowed_origins must contain landing_origin")
    return landing_origin, allowed_origins


def _normalized_url(value: object) -> NormalizedURL:
    if not isinstance(value, str):
        raise TypeError("URL must be a string")
    try:
        return normalize_url_with_configured_port(value)
    except (PolicyError, TypeError, ValueError):
        raise ValueError("URL must be a safe HTTPS locator") from None


@unique
class BrowserActionKind(str, Enum):
    """Closed operations available to a reviewed Browser action sequence."""

    CLICK = "click"
    OPEN_VIEWER = "open-viewer"
    OPEN_VERIFIED_LOCATOR = "open-verified-locator"
    WAIT_FOR_CAPTURE = "wait-for-capture"


@dataclass(frozen=True, slots=True, repr=False)
class BrowserRuleAction:
    """One statically bounded operation without script or expression support."""

    kind: BrowserActionKind
    selector: str | None = None
    locator: str | None = None
    capture_kind: BrowserCaptureKind | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.kind, BrowserActionKind):
            raise TypeError("kind must be a BrowserActionKind")
        selector = self.selector
        locator = self.locator
        capture_kind = self.capture_kind
        if self.kind is BrowserActionKind.CLICK:
            if selector is None or locator is not None or capture_kind is not None:
                raise ValueError("click actions require only one static selector")
            object.__setattr__(
                self,
                "selector",
                _static_selector(selector, field_name="selector"),
            )
            return
        if self.kind in {
            BrowserActionKind.OPEN_VIEWER,
            BrowserActionKind.OPEN_VERIFIED_LOCATOR,
        }:
            if selector is not None or locator is None or capture_kind is not None:
                raise ValueError("open actions require only one static locator")
            normalized = _normalized_url(locator)
            if normalized.scheme != "https" or normalized.query or normalized.path == "/":
                raise ValueError("action locators must be query-free HTTPS file locators")
            object.__setattr__(self, "locator", normalized.url)
            return
        if (
            selector is not None
            or locator is not None
            or not isinstance(capture_kind, BrowserCaptureKind)
        ):
            raise ValueError("wait actions require only one Browser capture kind")

    @property
    def fingerprint_fields(self) -> tuple[str, ...]:
        return (
            self.kind.value,
            self.selector or "",
            self.locator or "",
            "" if self.capture_kind is None else self.capture_kind.value,
        )


@unique
class BrowserPageMarkerKind(str, Enum):
    """Closed page facts a reviewed Provider rule may recognize."""

    AUTHENTICATED = "authenticated"
    ENTITLED = "entitled"
    LOGIN_REQUIRED = "login-required"
    MFA_REQUIRED = "mfa-required"
    NOT_ENTITLED = "not-entitled"
    PAYWALL = "paywall"
    CHALLENGE_REQUIRED = "challenge-required"
    RATE_LIMITED = "rate-limited"
    IP_BLOCKED = "ip-blocked"
    NOT_FOUND = "not-found"


@dataclass(frozen=True, slots=True)
class BrowserPageMarker:
    """One reviewed page fact matched by bounded static observations."""

    marker_id: str
    kind: BrowserPageMarkerKind
    css_selectors: tuple[str, ...] = field(default=(), repr=False)
    url_prefixes: tuple[str, ...] = field(default=(), repr=False)
    response_statuses: tuple[int, ...] = field(default=(), repr=False)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "marker_id",
            _stable_token(self.marker_id, field_name="marker_id"),
        )
        if not isinstance(self.kind, BrowserPageMarkerKind):
            raise TypeError("kind must be a BrowserPageMarkerKind")
        object.__setattr__(
            self,
            "css_selectors",
            _markers(self.css_selectors, field_name="css_selectors"),
        )
        object.__setattr__(self, "url_prefixes", _url_prefixes(self.url_prefixes))
        object.__setattr__(
            self,
            "response_statuses",
            _status_codes(self.response_statuses),
        )
        if not (self.css_selectors or self.url_prefixes or self.response_statuses):
            raise ValueError("a Browser page marker requires at least one bounded signal")

    def matches_observation(self, observation: BrowserPageObservation) -> bool:
        if not isinstance(observation, BrowserPageObservation):
            raise TypeError("observation must be a BrowserPageObservation")
        if observation.status_code in self.response_statuses:
            return True
        candidate = _normalized_url(observation.locator)
        for prefix_value in self.url_prefixes:
            prefix = _normalized_url(prefix_value)
            if candidate.origin != prefix.origin:
                continue
            prefix_path = prefix.path.rstrip("/")
            if candidate.path == prefix_path or candidate.path.startswith(f"{prefix_path}/"):
                return True
        return False

    @property
    def fingerprint_fields(self) -> tuple[str, ...]:
        return (
            self.marker_id,
            self.kind.value,
            *self.css_selectors,
            *self.url_prefixes,
            *(str(status) for status in self.response_statuses),
        )


@dataclass(frozen=True, slots=True)
class BrowserSiteRule:
    """One local, revisioned rule for one exact landing origin.

    ``allowed_origins`` is an explicit provider-rule allowlist, not a
    ``DestinationPolicy.allowed_origins`` value.  The latter only controls
    credential forwarding.  ``ControlledBrowserPdfSource`` supplies this
    tuple to Network's per-hop destination guard while Network independently
    retains URL, DNS, address and host-admission policy.
    """

    rule_id: str
    revision: int
    landing_origin: str
    allowed_origins: tuple[str, ...]
    web_scope_provider_name: str
    actions: tuple[BrowserRuleAction, ...] = field(default=(), repr=False)
    max_actions: int = _MAX_ACTIONS
    page_markers: tuple[BrowserPageMarker, ...] = field(default=(), repr=False)
    capture_url_prefixes: tuple[str, ...] = field(default=(), repr=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "rule_id", _stable_token(self.rule_id, field_name="rule_id"))
        if type(self.revision) is not int:
            raise TypeError("revision must be an integer")
        if self.revision < 1:
            raise ValueError("revision must be positive")
        landing_origin, allowed_origins = _rule_origins(
            self.landing_origin,
            self.allowed_origins,
        )
        object.__setattr__(self, "landing_origin", landing_origin)
        object.__setattr__(self, "allowed_origins", allowed_origins)
        object.__setattr__(
            self,
            "web_scope_provider_name",
            _stable_token(
                self.web_scope_provider_name,
                field_name="web_scope_provider_name",
            ),
        )
        if not isinstance(self.actions, tuple) or any(
            not isinstance(action, BrowserRuleAction) for action in self.actions
        ):
            raise TypeError("actions must contain BrowserRuleAction values")
        if type(self.max_actions) is not int:
            raise TypeError("max_actions must be an integer")
        if not 0 <= self.max_actions <= _MAX_ACTIONS:
            raise ValueError("max_actions exceeds the closed Browser action budget")
        if len(self.actions) > self.max_actions:
            raise ValueError("actions exceeds the rule's maximum action count")
        if any(
            action.locator is not None
            and _normalized_url(action.locator).origin.text not in self.allowed_origins
            for action in self.actions
        ):
            raise ValueError("action locators must use allowed rule origins")
        object.__setattr__(self, "capture_url_prefixes", _url_prefixes(self.capture_url_prefixes))
        if any(
            _normalized_url(prefix).origin.text not in self.allowed_origins
            for prefix in self.capture_url_prefixes
        ):
            raise ValueError("capture URL prefixes must use allowed rule origins")
        if any(
            action.locator is not None
            and not self.allows_capture(
                action.locator,
                (
                    BrowserCaptureKind.VIEWER
                    if action.kind is BrowserActionKind.OPEN_VIEWER
                    else BrowserCaptureKind.VERIFIED_LOCATOR
                ),
                "application/pdf",
            )
            for action in self.actions
        ):
            raise ValueError("open action locators must match a reviewed capture prefix")
        self._validate_page_markers()

    def _validate_page_markers(self) -> None:
        if not isinstance(self.page_markers, tuple) or any(
            not isinstance(marker, BrowserPageMarker) for marker in self.page_markers
        ):
            raise TypeError("page_markers must contain BrowserPageMarker values")
        if len(self.page_markers) > _MAX_PAGE_MARKERS:
            raise ValueError("page_markers contains too many reviewed markers")
        marker_ids = tuple(marker.marker_id for marker in self.page_markers)
        selectors = tuple(
            selector for marker in self.page_markers for selector in marker.css_selectors
        )
        prefixes = tuple(prefix for marker in self.page_markers for prefix in marker.url_prefixes)
        statuses = tuple(
            status for marker in self.page_markers for status in marker.response_statuses
        )
        if len(marker_ids) != len(set(marker_ids)):
            raise ValueError("page marker ids must be unique")
        if len(selectors) != len(set(selectors)):
            raise ValueError("page marker selectors must be unambiguous")
        if len(prefixes) != len(set(prefixes)):
            raise ValueError("page marker URL prefixes must be unambiguous")
        if len(statuses) != len(set(statuses)):
            raise ValueError("page marker response statuses must be unambiguous")
        if any(
            _normalized_url(prefix).origin.text not in self.allowed_origins
            for marker in self.page_markers
            for prefix in marker.url_prefixes
        ):
            raise ValueError("page marker URL prefixes must use allowed rule origins")

    @property
    def landing_hostname(self) -> str:
        """Return the canonical DNS name used by the A5-compatible scope seam."""

        return _normalized_url(self.landing_origin).hostname

    @property
    def fingerprint(self) -> Sha256:
        """Hash the complete public rule without exposing its selector in a key."""

        fields = (
            self.rule_id,
            str(self.revision),
            self.landing_origin,
            *self.allowed_origins,
            self.web_scope_provider_name,
            str(self.max_actions),
            str(len(self.actions)),
            *(field for action in self.actions for field in action.fingerprint_fields),
            *self.capture_url_prefixes,
            *(field for marker in self.page_markers for field in marker.fingerprint_fields),
        )
        return Sha256(hashlib.sha256("\x00".join(fields).encode("utf-8", "strict")).hexdigest())

    def matches_origin(self, value: str) -> bool:
        """Return whether ``value`` is exactly this rule's HTTPS landing origin."""

        try:
            candidate = _exact_https_origin(value, field_name="origin")
        except (TypeError, ValueError):
            return False
        return candidate == self.landing_origin

    def allows_url(self, value: str) -> bool:
        """Return whether a safe locator belongs to an explicitly allowed origin."""

        try:
            candidate = _normalized_url(value)
        except (TypeError, ValueError):
            return False
        return candidate.origin.text in self.allowed_origins

    def allows_capture(
        self,
        value: str,
        kind: BrowserCaptureKind,
        media_type: str,
    ) -> bool:
        """Match one already-admitted body to a reviewed PDF locator prefix."""

        if not isinstance(kind, BrowserCaptureKind) or not isinstance(media_type, str):
            return False
        normalized_media_type = media_type.split(";", 1)[0].strip().casefold()
        if normalized_media_type not in {"application/pdf", "application/octet-stream"}:
            return False
        try:
            candidate = _normalized_url(value)
        except (TypeError, ValueError):
            return False
        for prefix_value in self.capture_url_prefixes:
            prefix = _normalized_url(prefix_value)
            if candidate.origin != prefix.origin:
                continue
            prefix_path = prefix.path.rstrip("/")
            if candidate.path == prefix_path or candidate.path.startswith(f"{prefix_path}/"):
                return True
        return False


@dataclass(frozen=True, slots=True)
class BrowserRuleCatalog:
    """A closed in-memory catalog with one current rule per exact origin."""

    rules: tuple[BrowserSiteRule, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.rules, tuple):
            raise TypeError("rules must be a tuple")
        if any(not isinstance(rule, BrowserSiteRule) for rule in self.rules):
            raise TypeError("rules must contain BrowserSiteRule values")
        rule_ids = tuple(rule.rule_id for rule in self.rules)
        origins = tuple(rule.landing_origin for rule in self.rules)
        if len(set(rule_ids)) != len(rule_ids):
            raise ValueError("rules must have unique stable rule ids")
        if len(set(origins)) != len(origins):
            raise ValueError("rules must have unique landing origins")

    def match_origin(self, value: str) -> BrowserSiteRule | None:
        """Find an exact local origin match without performing any I/O."""

        try:
            origin = _exact_https_origin(value, field_name="origin")
        except (TypeError, ValueError):
            return None
        return next((rule for rule in self.rules if rule.landing_origin == origin), None)

    def match_url(self, value: str) -> BrowserSiteRule | None:
        """Find the rule whose exact landing origin owns a safe locator."""

        try:
            normalized = _normalized_url(value)
        except (TypeError, ValueError):
            return None
        return self.match_origin(normalized.origin.text)


# No production selector or Browser factory has been verified.  Keeping this
# value empty is a security/readiness decision, not an unfinished placeholder
# that callers may silently treat as a supported provider matrix.
PRODUCTION_BROWSER_RULE_CATALOG: Final[BrowserRuleCatalog] = BrowserRuleCatalog()


__all__ = (
    "BrowserActionKind",
    "BrowserPageMarker",
    "BrowserPageMarkerKind",
    "BrowserRuleAction",
    "BrowserRuleCatalog",
    "BrowserSiteRule",
    "PRODUCTION_BROWSER_RULE_CATALOG",
)
