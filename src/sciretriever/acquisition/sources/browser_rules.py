"""Local declarative rules for controlled Browser acquisition.

Rules in this module are deliberately small, immutable, and executable only
through the fixed operations understood by :mod:`acquisition.sources.browser`.
They are not a remote rule language: there is no loader, JavaScript surface,
login form description, Cookie/profile data, selector guessing, or fallback
action sequence.

The production catalog is intentionally empty.  A real provider rule must be
verified together with a Browser runner that can enforce the rule's exact
origin set before every navigation, popup, and download.  The current Network
Browser boundary performs general destination safety checks but does not yet
provide that provider-rule admission hook.
"""

from __future__ import annotations

import hashlib
import ipaddress
import re
from dataclasses import dataclass
from enum import Enum, unique
from typing import Final

from sciretriever.model.primitives import Sha256
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


def _rule_selector(action: object, selector: object) -> str | None:
    if not isinstance(action, BrowserRuleAction):
        raise TypeError("action must be a BrowserRuleAction")
    if action is BrowserRuleAction.OBSERVE_ONLY:
        if selector is not None:
            raise ValueError("observe-only rules must not contain a click selector")
        return None
    if selector is None:
        raise ValueError("explicit-click rules require one click selector")
    return _static_selector(selector, field_name="click_selector")


def _normalized_url(value: object) -> NormalizedURL:
    if not isinstance(value, str):
        raise TypeError("URL must be a string")
    try:
        return normalize_url_with_configured_port(value)
    except (PolicyError, TypeError, ValueError):
        raise ValueError("URL must be a safe HTTPS locator") from None


@unique
class BrowserRuleAction(str, Enum):
    """The only two actions available to a controlled Browser rule."""

    OBSERVE_ONLY = "observe-only"
    EXPLICIT_CLICK = "explicit-click"


@dataclass(frozen=True, slots=True)
class BrowserSiteRule:
    """One local, revisioned rule for one exact landing origin.

    ``allowed_origins`` is an explicit provider-rule allowlist, not a
    ``DestinationPolicy.allowed_origins`` value.  The latter only controls
    credential forwarding.  A future production runner must apply this tuple
    before every navigation, popup, and download; the current Source can only
    precheck the start and postcheck the neutral final download locator.
    """

    rule_id: str
    revision: int
    landing_origin: str
    allowed_origins: tuple[str, ...]
    web_scope_provider_name: str
    action: BrowserRuleAction
    click_selector: str | None = None
    login_markers: tuple[str, ...] = ()
    mfa_markers: tuple[str, ...] = ()

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
        object.__setattr__(
            self,
            "click_selector",
            _rule_selector(self.action, self.click_selector),
        )
        object.__setattr__(
            self,
            "login_markers",
            _markers(self.login_markers, field_name="login_markers"),
        )
        object.__setattr__(
            self,
            "mfa_markers",
            _markers(self.mfa_markers, field_name="mfa_markers"),
        )
        if set(self.login_markers) & set(self.mfa_markers):
            raise ValueError("login and MFA markers must be distinct")

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
            self.action.value,
            self.click_selector or "",
            *self.login_markers,
            *self.mfa_markers,
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
    "BrowserRuleAction",
    "BrowserRuleCatalog",
    "BrowserSiteRule",
    "PRODUCTION_BROWSER_RULE_CATALOG",
)
