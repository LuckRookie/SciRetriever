"""Closed data model for controlled Browser site rules.

The immutable types in this module define the only rule language understood by
the controlled Browser source. Provider-specific declarations and production
admission catalogs live in sibling modules; none of them may extend this model
with remote code, arbitrary JavaScript, credentials, or generic fallback logic.
"""

from __future__ import annotations

import hashlib
import ipaddress
import re
from dataclasses import dataclass, field
from enum import Enum, unique
from typing import Final
from urllib.parse import quote, unquote, urlsplit

from sciretriever.model.access import BrowserCaptureKind
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import Sha256
from sciretriever.network.browser import BrowserPageObservation, BrowserRequestObservation
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
_DEFAULT_CAPTURE_PRIORITY: Final[tuple[BrowserCaptureKind, ...]] = (
    BrowserCaptureKind.VERIFIED_LOCATOR,
    BrowserCaptureKind.DOWNLOAD,
    BrowserCaptureKind.RESPONSE,
    BrowserCaptureKind.VIEWER,
    BrowserCaptureKind.POPUP,
)

# These are diagnostic families, not an allow-list.  Keep the values short and
# fixed so a rejected Cloudflare request can be explained without logging its
# path, query, or any token-like locator component.
_CHALLENGE_PLATFORM_PATH: Final[str] = "/cdn-cgi/challenge-platform"
_TURNSTILE_PATH: Final[str] = "/turnstile"


@unique
class BrowserChallengePathFamily(str, Enum):
    """Low-sensitivity Cloudflare path families used by rejection diagnostics."""

    CHALLENGE_PLATFORM = "challenge-platform"
    TURNSTILE = "turnstile"
    OTHER = "other"


def _path_has_family_prefix(path: str, prefix: str) -> bool:
    """Match one fixed path family without treating lookalikes as members."""

    return path == prefix or path.startswith(f"{prefix}/")


def _challenge_path_family(path: str) -> BrowserChallengePathFamily:
    """Classify a normalized path using only fixed, non-sensitive prefixes."""

    folded = path.casefold()
    if _path_has_family_prefix(folded, _CHALLENGE_PLATFORM_PATH):
        return BrowserChallengePathFamily.CHALLENGE_PLATFORM
    if _path_has_family_prefix(folded, _TURNSTILE_PATH):
        return BrowserChallengePathFamily.TURNSTILE
    return BrowserChallengePathFamily.OTHER


@dataclass(frozen=True, slots=True, repr=False)
class BrowserChallengeResourceProfile:
    """One reviewed third-party resource profile scoped to one site rule.

    The profile deliberately does not become part of ``allowed_origins``: it
    is only admitted when a request carries proof that it was initiated by the
    current Publisher page/frame.  Paths and resource types are closed and
    query-free so a challenge host cannot silently become a general-purpose
    navigation, download or capture target.
    """

    origin: str
    path_prefixes: tuple[str, ...]
    resource_types: tuple[str, ...]
    interaction_selectors: tuple[str, ...] = ()
    settling_selectors: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "origin", _exact_https_origin(self.origin, field_name="origin"))
        if not isinstance(self.path_prefixes, tuple) or not self.path_prefixes:
            raise TypeError("path_prefixes must be a non-empty tuple")
        if len(self.path_prefixes) > _MAX_MARKERS:
            raise ValueError("path_prefixes contains too many markers")
        normalized_paths: list[str] = []
        for value in self.path_prefixes:
            try:
                normalized = _normalized_url(value)
            except (TypeError, ValueError):
                raise ValueError("path_prefixes must contain safe HTTPS URLs") from None
            if normalized.origin.text != self.origin or normalized.query or normalized.path == "/":
                raise ValueError("path_prefixes must be query-free paths on origin")
            normalized_paths.append(normalized.url)
        if len(set(normalized_paths)) != len(normalized_paths):
            raise ValueError("path_prefixes must not contain duplicates")
        object.__setattr__(self, "path_prefixes", tuple(normalized_paths))
        if not isinstance(self.resource_types, tuple) or not self.resource_types:
            raise TypeError("resource_types must be a non-empty tuple")
        if len(self.resource_types) > _MAX_MARKERS:
            raise ValueError("resource_types contains too many markers")
        resource_types = tuple(
            _stable_token(value, field_name="resource_type") for value in self.resource_types
        )
        if len(set(resource_types)) != len(resource_types):
            raise ValueError("resource_types must not contain duplicates")
        object.__setattr__(self, "resource_types", resource_types)
        object.__setattr__(
            self,
            "interaction_selectors",
            _markers(self.interaction_selectors, field_name="interaction_selectors"),
        )
        object.__setattr__(
            self,
            "settling_selectors",
            _markers(self.settling_selectors, field_name="settling_selectors"),
        )

    @property
    def connection_origins(self) -> tuple[str, ...]:
        """Return the exact origin needed by the CONNECT prebind boundary."""

        return (self.origin,)

    def match_reason(
        self,
        observation: BrowserRequestObservation,
    ) -> "BrowserChallengeResourceMatch":
        """Classify one request without exposing its locator or payload.

        The result is intentionally a bounded enum so a guard can explain a
        local policy rejection using only low-sensitivity request facts.  The
        frame/ancestry proof remains the guard's responsibility.
        """

        if not isinstance(observation, BrowserRequestObservation):
            raise TypeError("observation must be a BrowserRequestObservation")
        candidate = _normalized_url(observation.locator)
        if candidate.origin.text != self.origin:
            return BrowserChallengeResourceMatch.ORIGIN_MISMATCH
        if observation.resource_type not in self.resource_types:
            return BrowserChallengeResourceMatch.RESOURCE_TYPE_MISMATCH
        if not any(
            candidate.path == prefix.path.rstrip("/")
            or candidate.path.startswith(f"{prefix.path.rstrip('/')}/")
            for prefix in (_normalized_url(value) for value in self.path_prefixes)
        ):
            return BrowserChallengeResourceMatch.PATH_MISMATCH
        return BrowserChallengeResourceMatch.ADMITTED

    def matches(self, observation: BrowserRequestObservation) -> bool:
        return self.match_reason(observation) is BrowserChallengeResourceMatch.ADMITTED

    def path_family(self, observation: BrowserRequestObservation) -> BrowserChallengePathFamily:
        """Return a bounded diagnostic family without exposing the locator."""

        if not isinstance(observation, BrowserRequestObservation):
            raise TypeError("observation must be a BrowserRequestObservation")
        return _challenge_path_family(_normalized_url(observation.locator).path)

    @property
    def fingerprint_fields(self) -> tuple[str, ...]:
        return (
            self.origin,
            *self.path_prefixes,
            *self.resource_types,
            "interaction-selectors",
            *self.interaction_selectors,
            "settling-selectors",
            *self.settling_selectors,
        )


@unique
class BrowserChallengeResourceMatch(str, Enum):
    """Bounded profile-match outcomes safe for diagnostic logging."""

    ADMITTED = "admitted"
    ORIGIN_MISMATCH = "origin-mismatch"
    RESOURCE_TYPE_MISMATCH = "resource-type-mismatch"
    PATH_MISMATCH = "path-mismatch"


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


def _text_markers(value: object) -> tuple[tuple[str, str], ...]:
    if not isinstance(value, tuple):
        raise TypeError("text_markers must be a tuple")
    if len(value) > _MAX_MARKERS:
        raise ValueError("text_markers contains too many markers")
    result: list[tuple[str, str]] = []
    for item in value:
        if not isinstance(item, tuple) or len(item) != 2:
            raise TypeError("text_markers must contain selector and fragment tuples")
        selector = _static_selector(item[0], field_name="text marker selector")
        fragment_value = item[1]
        if not isinstance(fragment_value, str):
            raise TypeError("text marker fragment must be a string")
        fragment = fragment_value.strip().casefold()
        if (
            len(fragment) < 2
            or len(fragment) > 160
            or _CONTROL_CHARACTER.search(fragment) is not None
        ):
            raise ValueError("text marker fragment must be bounded plain text")
        result.append((selector, fragment))
    if len(set(result)) != len(result):
        raise ValueError("text_markers must not contain duplicates")
    return tuple(result)


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


def _origin_roots(value: object, *, field_name: str) -> tuple[str, ...]:
    if not isinstance(value, tuple):
        raise TypeError(f"{field_name} must be a tuple")
    if len(value) > _MAX_MARKERS:
        raise ValueError(f"{field_name} contains too many origins")
    result = tuple(_exact_https_origin(item, field_name=field_name) for item in value)
    if len(set(result)) != len(result):
        raise ValueError(f"{field_name} must not contain duplicates")
    return result


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


def _stable_tokens(value: object, *, field_name: str) -> tuple[str, ...]:
    if not isinstance(value, tuple):
        raise TypeError(f"{field_name} must be a tuple")
    if len(value) > _MAX_MARKERS:
        raise ValueError(f"{field_name} contains too many markers")
    result = tuple(_stable_token(item, field_name=field_name) for item in value)
    if len(set(result)) != len(result):
        raise ValueError(f"{field_name} must not contain duplicates")
    return result


def _capture_priority(value: object) -> tuple[BrowserCaptureKind, ...]:
    if not isinstance(value, tuple) or any(
        not isinstance(kind, BrowserCaptureKind) for kind in value
    ):
        raise TypeError("capture_priority must contain BrowserCaptureKind values")
    if len(value) != len(BrowserCaptureKind) or set(value) != set(BrowserCaptureKind):
        raise ValueError("capture_priority must rank every Browser capture kind exactly once")
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
    WAIT_FOR_ANY_CAPTURE = "wait-for-any-capture"


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
        if self.kind is BrowserActionKind.WAIT_FOR_ANY_CAPTURE:
            if selector is not None or locator is not None or capture_kind is not None:
                raise ValueError("wait-for-any actions do not accept operands")
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
class BrowserArticleIdentityKind(str, Enum):
    """Closed evidence comparisons that can bind a capture to one article."""

    EXACT_LANDING = "exact-landing"
    LANDING_PATH_STEM = "landing-path-stem"
    LANDING_PATH_TOKEN = "landing-path-token"
    IDENTIFIER_IN_PATH = "identifier-in-path"


@unique
class BrowserCaptureDisposition(str, Enum):
    """Provider-rule decision for one safe Browser capture locator."""

    PRIMARY = "primary"
    SUPPLEMENT = "supplement"
    EXCLUDED = "excluded"
    WRONG_ARTICLE = "wrong-article"
    REJECTED = "rejected"


@unique
class BrowserPageMarkerKind(str, Enum):
    """Closed page facts a reviewed Provider rule may recognize."""

    AUTHENTICATED = "authenticated"
    ENTITLED = "entitled"
    LOGIN_REQUIRED = "login-required"
    MFA_REQUIRED = "mfa-required"
    NOT_ENTITLED = "not-entitled"
    PAYWALL = "paywall"
    ACCESS_DENIED = "access-denied"
    CHALLENGE = "challenge"
    RATE_LIMITED = "rate-limited"
    IP_BLOCKED = "ip-blocked"
    ACCOUNT_WARNING = "account-warning"
    NOT_FOUND = "not-found"


@dataclass(frozen=True, slots=True)
class BrowserPageMarker:
    """One reviewed page fact matched by bounded static observations."""

    marker_id: str
    kind: BrowserPageMarkerKind
    css_selectors: tuple[str, ...] = field(default=(), repr=False)
    text_markers: tuple[tuple[str, str], ...] = field(default=(), repr=False)
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
        object.__setattr__(self, "text_markers", _text_markers(self.text_markers))
        object.__setattr__(self, "url_prefixes", _url_prefixes(self.url_prefixes))
        object.__setattr__(
            self,
            "response_statuses",
            _status_codes(self.response_statuses),
        )
        if not (
            self.css_selectors or self.text_markers or self.url_prefixes or self.response_statuses
        ):
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
            *(field for marker in self.text_markers for field in marker),
            *self.url_prefixes,
            *(str(status) for status in self.response_statuses),
        )


def _matches_url_prefix(candidate: NormalizedURL, prefixes: tuple[str, ...]) -> bool:
    for prefix_value in prefixes:
        prefix = _normalized_url(prefix_value)
        if candidate.origin != prefix.origin:
            continue
        prefix_path = prefix.path.rstrip("/")
        if candidate.path == prefix_path or candidate.path.startswith(f"{prefix_path}/"):
            return True
    return False


def _decoded_path(value: NormalizedURL) -> str:
    return unquote(value.path, errors="strict").casefold()


def _filename(value: NormalizedURL) -> str:
    return _decoded_path(value).rstrip("/").rsplit("/", 1)[-1]


def _path_stem(value: str) -> str:
    return value[:-4] if value.endswith(".pdf") else value


def _doi_pdf_url_template(value: object) -> str:
    if type(value) is not str:
        raise TypeError("doi_pdf_url_template must be a string")
    candidate = value.strip()
    if (
        candidate.count("{doi}") != 1
        or "{" in candidate.replace("{doi}", "")
        or "}" in candidate.replace("{doi}", "")
        or _CONTROL_CHARACTER.search(candidate) is not None
    ):
        raise ValueError("doi_pdf_url_template must contain one DOI path placeholder")
    sample = candidate.replace("{doi}", quote("10.1000/browser-fixture", safe="/"))
    normalized = _normalized_url(sample)
    parsed = urlsplit(sample)
    if normalized.scheme != "https" or parsed.query or parsed.fragment:
        raise ValueError("doi_pdf_url_template must be a query-free HTTPS locator")
    return candidate


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
    landing_origin_aliases: tuple[str, ...] = field(default=(), repr=False)
    actions: tuple[BrowserRuleAction, ...] = field(default=(), repr=False)
    actions_require_entitlement: bool = False
    doi_pdf_url_template: str | None = field(default=None, repr=False)
    page_markers: tuple[BrowserPageMarker, ...] = field(default=(), repr=False)
    capture_url_prefixes: tuple[str, ...] = field(default=(), repr=False)
    capture_origin_roots: tuple[str, ...] = field(default=(), repr=False)
    capture_root_filename_markers: tuple[str, ...] = field(default=(), repr=False)
    article_identity_kinds: tuple[BrowserArticleIdentityKind, ...] = field(
        default=(BrowserArticleIdentityKind.LANDING_PATH_STEM,),
        repr=False,
    )
    article_id_namespaces: tuple[str, ...] = field(default=(), repr=False)
    supplement_url_prefixes: tuple[str, ...] = field(default=(), repr=False)
    supplement_selectors: tuple[str, ...] = field(default=(), repr=False)
    supplement_filename_markers: tuple[str, ...] = field(default=(), repr=False)
    excluded_url_prefixes: tuple[str, ...] = field(default=(), repr=False)
    excluded_filename_markers: tuple[str, ...] = field(default=(), repr=False)
    capture_priority: tuple[BrowserCaptureKind, ...] = field(
        default=_DEFAULT_CAPTURE_PRIORITY,
        repr=False,
    )
    challenge_resource_profile: BrowserChallengeResourceProfile | None = field(
        default=None,
        repr=False,
    )

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
        aliases = _origin_roots(
            self.landing_origin_aliases,
            field_name="landing_origin_aliases",
        )
        if landing_origin in aliases:
            raise ValueError("landing_origin_aliases must not repeat landing_origin")
        if any(origin not in allowed_origins for origin in aliases):
            raise ValueError("landing_origin_aliases must use allowed rule origins")
        object.__setattr__(self, "landing_origin_aliases", aliases)
        object.__setattr__(
            self,
            "web_scope_provider_name",
            _stable_token(
                self.web_scope_provider_name,
                field_name="web_scope_provider_name",
            ),
        )
        self._validate_actions()
        self._normalize_document_rules()
        self._validate_document_rules()
        self._validate_page_markers()
        if self.challenge_resource_profile is not None and not isinstance(
            self.challenge_resource_profile,
            BrowserChallengeResourceProfile,
        ):
            raise TypeError(
                "challenge_resource_profile must be a BrowserChallengeResourceProfile or None"
            )
        if (
            self.challenge_resource_profile is not None
            and self.challenge_resource_profile.origin in self.allowed_origins
        ):
            raise ValueError("challenge resource origin must remain outside allowed_origins")

    def _validate_actions(self) -> None:
        if not isinstance(self.actions, tuple) or any(
            not isinstance(action, BrowserRuleAction) for action in self.actions
        ):
            raise TypeError("actions must contain BrowserRuleAction values")
        if any(
            action.locator is not None
            and _normalized_url(action.locator).origin.text not in self.allowed_origins
            for action in self.actions
        ):
            raise ValueError("action locators must use allowed rule origins")
        if type(self.actions_require_entitlement) is not bool:
            raise TypeError("actions_require_entitlement must be a bool")

    def _normalize_document_rules(self) -> None:
        if self.doi_pdf_url_template is not None:
            object.__setattr__(
                self,
                "doi_pdf_url_template",
                _doi_pdf_url_template(self.doi_pdf_url_template),
            )
        object.__setattr__(
            self,
            "capture_url_prefixes",
            _url_prefixes(self.capture_url_prefixes),
        )
        object.__setattr__(
            self,
            "capture_origin_roots",
            _origin_roots(
                self.capture_origin_roots,
                field_name="capture_origin_roots",
            ),
        )
        object.__setattr__(
            self,
            "capture_root_filename_markers",
            _stable_tokens(
                self.capture_root_filename_markers,
                field_name="capture_root_filename_markers",
            ),
        )
        object.__setattr__(
            self,
            "supplement_url_prefixes",
            _url_prefixes(self.supplement_url_prefixes),
        )
        object.__setattr__(
            self,
            "excluded_url_prefixes",
            _url_prefixes(self.excluded_url_prefixes),
        )
        if not isinstance(self.article_identity_kinds, tuple) or any(
            not isinstance(kind, BrowserArticleIdentityKind) for kind in self.article_identity_kinds
        ):
            raise TypeError("article_identity_kinds must contain closed identity kinds")
        if len(set(self.article_identity_kinds)) != len(self.article_identity_kinds):
            raise ValueError("article_identity_kinds must not contain duplicates")
        if (
            self.capture_url_prefixes or self.capture_origin_roots
        ) and not self.article_identity_kinds:
            raise ValueError("capture rules require an article identity rule")
        object.__setattr__(
            self,
            "article_id_namespaces",
            _stable_tokens(self.article_id_namespaces, field_name="article_id_namespaces"),
        )
        requires_identifiers = (
            BrowserArticleIdentityKind.IDENTIFIER_IN_PATH in self.article_identity_kinds
        )
        if requires_identifiers != bool(self.article_id_namespaces):
            raise ValueError(
                "identifier-in-path identity and article_id_namespaces must be declared together"
            )
        object.__setattr__(
            self,
            "supplement_selectors",
            _markers(self.supplement_selectors, field_name="supplement_selectors"),
        )
        object.__setattr__(
            self,
            "supplement_filename_markers",
            _stable_tokens(
                self.supplement_filename_markers,
                field_name="supplement_filename_markers",
            ),
        )
        object.__setattr__(
            self,
            "excluded_filename_markers",
            _stable_tokens(
                self.excluded_filename_markers,
                field_name="excluded_filename_markers",
            ),
        )
        object.__setattr__(self, "capture_priority", _capture_priority(self.capture_priority))

    def _validate_document_rules(self) -> None:
        self._validate_document_origins()
        self._validate_document_exclusions()
        self._validate_document_actions()
        self._validate_doi_document_locator()

    def _validate_document_origins(self) -> None:
        if any(
            _normalized_url(prefix).origin.text not in self.allowed_origins
            for prefix in (
                *self.capture_url_prefixes,
                *self.supplement_url_prefixes,
                *self.excluded_url_prefixes,
            )
        ):
            raise ValueError("document URL prefixes must use allowed rule origins")
        if any(origin not in self.allowed_origins for origin in self.capture_origin_roots):
            raise ValueError("capture origin roots must use allowed rule origins")
        if bool(self.capture_origin_roots) != bool(self.capture_root_filename_markers):
            raise ValueError("capture origin roots require closed primary filename markers")

    def _validate_document_exclusions(self) -> None:
        if set(self.supplement_url_prefixes) & set(self.excluded_url_prefixes):
            raise ValueError("supplement and excluded URL prefixes must be unambiguous")
        if set(self.supplement_filename_markers) & set(self.excluded_filename_markers):
            raise ValueError("supplement and excluded filename markers must be unambiguous")

    def _validate_document_actions(self) -> None:
        if any(
            action.kind is BrowserActionKind.CLICK and action.selector in self.supplement_selectors
            for action in self.actions
        ):
            raise ValueError("Browser actions must not click known supplement selectors")
        if any(
            action.locator is not None
            and not _matches_url_prefix(
                _normalized_url(action.locator),
                self.capture_url_prefixes,
            )
            for action in self.actions
        ):
            raise ValueError("open action locators must match a reviewed capture prefix")

    def _validate_doi_document_locator(self) -> None:
        if self.doi_pdf_url_template is not None:
            sample = self.doi_pdf_url_template.replace(
                "{doi}",
                quote("10.1000/browser-fixture", safe="/"),
            )
            normalized = _normalized_url(sample)
            if normalized.origin.text not in self.allowed_origins:
                raise ValueError("DOI PDF locators must use an allowed rule origin")
            if not _matches_url_prefix(normalized, self.capture_url_prefixes):
                raise ValueError("DOI PDF locators must match a reviewed capture prefix")
            if (
                BrowserArticleIdentityKind.IDENTIFIER_IN_PATH not in self.article_identity_kinds
                or "doi" not in self.article_id_namespaces
            ):
                raise ValueError("DOI PDF locators require DOI path identity")

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
        text_markers = tuple(
            text_marker for marker in self.page_markers for text_marker in marker.text_markers
        )
        prefixes = tuple(prefix for marker in self.page_markers for prefix in marker.url_prefixes)
        statuses = tuple(
            status for marker in self.page_markers for status in marker.response_statuses
        )
        if len(marker_ids) != len(set(marker_ids)):
            raise ValueError("page marker ids must be unique")
        if len(selectors) != len(set(selectors)):
            raise ValueError("page marker selectors must be unambiguous")
        if len(text_markers) != len(set(text_markers)):
            raise ValueError("page text markers must be unambiguous")
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
        if self.actions_require_entitlement and (
            not self.actions
            or not any(
                marker.kind is BrowserPageMarkerKind.ENTITLED for marker in self.page_markers
            )
        ):
            raise ValueError("entitlement-gated actions require actions and an entitlement marker")

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
            *self.landing_origin_aliases,
            *self.allowed_origins,
            self.web_scope_provider_name,
            str(len(self.actions)),
            str(self.actions_require_entitlement).lower(),
            *(field for action in self.actions for field in action.fingerprint_fields),
            "doi-pdf-url-template",
            self.doi_pdf_url_template or "",
            "article-identity",
            str(len(self.article_identity_kinds)),
            *(kind.value for kind in self.article_identity_kinds),
            str(len(self.article_id_namespaces)),
            *self.article_id_namespaces,
            "capture-prefixes",
            str(len(self.capture_url_prefixes)),
            *self.capture_url_prefixes,
            "capture-origin-roots",
            str(len(self.capture_origin_roots)),
            *self.capture_origin_roots,
            "capture-root-filenames",
            str(len(self.capture_root_filename_markers)),
            *self.capture_root_filename_markers,
            "supplement-prefixes",
            str(len(self.supplement_url_prefixes)),
            *self.supplement_url_prefixes,
            "supplement-selectors",
            str(len(self.supplement_selectors)),
            *self.supplement_selectors,
            "supplement-filenames",
            str(len(self.supplement_filename_markers)),
            *self.supplement_filename_markers,
            "excluded-prefixes",
            str(len(self.excluded_url_prefixes)),
            *self.excluded_url_prefixes,
            "excluded-filenames",
            str(len(self.excluded_filename_markers)),
            *self.excluded_filename_markers,
            "capture-priority",
            *(kind.value for kind in self.capture_priority),
            "page-markers",
            str(len(self.page_markers)),
            *(field for marker in self.page_markers for field in marker.fingerprint_fields),
            "challenge-resource-profile",
            ""
            if self.challenge_resource_profile is None
            else "\x00".join(self.challenge_resource_profile.fingerprint_fields),
        )
        return Sha256(hashlib.sha256("\x00".join(fields).encode("utf-8", "strict")).hexdigest())

    def matches_origin(self, value: str) -> bool:
        """Return whether ``value`` is one reviewed Publisher landing origin."""

        try:
            candidate = _exact_https_origin(value, field_name="origin")
        except (TypeError, ValueError):
            return False
        return candidate in self.recognized_landing_origins

    @property
    def recognized_landing_origins(self) -> tuple[str, ...]:
        """Return the canonical Browser entry followed by reviewed DOI aliases."""

        return (self.landing_origin, *self.landing_origin_aliases)

    def allows_url(self, value: str) -> bool:
        """Return whether a safe locator belongs to an explicitly allowed origin."""

        try:
            candidate = _normalized_url(value)
        except (TypeError, ValueError):
            return False
        return candidate.origin.text in self.allowed_origins

    def allows_challenge_origin(self, value: str) -> bool:
        """Return whether ``value`` uses this rule's reviewed dependency."""

        profile = self.challenge_resource_profile
        if profile is None:
            return False
        try:
            candidate = _normalized_url(value)
        except (TypeError, ValueError):
            return False
        return candidate.origin.text == profile.origin

    def matches_challenge_request(self, observation: BrowserRequestObservation) -> bool:
        """Match dependency path/type; frame proof is checked by the guard."""

        profile = self.challenge_resource_profile
        return profile is not None and profile.matches(observation)

    def doi_pdf_locator(self, identifiers: tuple[Identifier, ...]) -> str | None:
        """Build one reviewed direct-PDF Browser locator from one neutral DOI."""

        if not isinstance(identifiers, tuple) or any(
            not isinstance(identifier, Identifier) for identifier in identifiers
        ):
            raise TypeError("identifiers must contain neutral Identifier values")
        template = self.doi_pdf_url_template
        dois = tuple(
            identifier.value for identifier in identifiers if identifier.namespace == "doi"
        )
        if template is None or len(dois) != 1:
            return None
        return _normalized_url(template.replace("{doi}", quote(dois[0], safe="/"))).url

    def classify_capture(
        self,
        value: str,
        kind: BrowserCaptureKind,
        media_type: str,
        *,
        landing_url: str | None,
        identifiers: tuple[Identifier, ...],
    ) -> BrowserCaptureDisposition:
        """Classify one safe locator before body access and again before delivery."""

        if not isinstance(kind, BrowserCaptureKind) or not isinstance(media_type, str):
            return BrowserCaptureDisposition.REJECTED
        if not isinstance(identifiers, tuple) or any(
            not isinstance(identifier, Identifier) for identifier in identifiers
        ):
            raise TypeError("identifiers must contain neutral Identifier values")
        normalized_media_type = media_type.split(";", 1)[0].strip().casefold()
        if normalized_media_type not in {"application/pdf", "application/octet-stream"}:
            return BrowserCaptureDisposition.REJECTED
        try:
            candidate = _normalized_url(value)
        except (TypeError, ValueError):
            return BrowserCaptureDisposition.REJECTED
        filename = _filename(candidate)
        if _matches_url_prefix(candidate, self.supplement_url_prefixes) or any(
            marker in filename for marker in self.supplement_filename_markers
        ):
            return BrowserCaptureDisposition.SUPPLEMENT
        if _matches_url_prefix(candidate, self.excluded_url_prefixes) or any(
            marker in filename for marker in self.excluded_filename_markers
        ):
            return BrowserCaptureDisposition.EXCLUDED
        prefix_match = _matches_url_prefix(candidate, self.capture_url_prefixes)
        root_match = candidate.origin.text in self.capture_origin_roots and any(
            marker in filename for marker in self.capture_root_filename_markers
        )
        if not (prefix_match or root_match):
            return BrowserCaptureDisposition.REJECTED
        if not self._matches_article_identity(candidate, landing_url, identifiers):
            return BrowserCaptureDisposition.WRONG_ARTICLE
        return BrowserCaptureDisposition.PRIMARY

    def safe_capture_locator(self, value: str) -> str:
        """Return a persistable capture locator without transient query material.

        Browser PDF endpoints frequently redirect to signed CDN URLs.  The
        complete locator remains operation-local for request admission and
        capture identity, but query parameters are never suitable provenance
        or catalog data.  The normalized origin and path are sufficient to
        describe where the captured bytes came from without retaining a
        bearer-like signature.
        """

        candidate = _normalized_url(value)
        if candidate.origin.text not in self.allowed_origins:
            raise ValueError("capture locator must use an allowed rule origin")
        return f"{candidate.origin.text}{candidate.path}"

    def matches_article_landing(
        self,
        value: str,
        *,
        landing_url: str | None,
        identifiers: tuple[Identifier, ...],
    ) -> bool:
        """Return whether a Publisher page change preserves article identity.

        A Publisher may replace an article URL with another same-article path
        while a third-party verification script is loading.  The challenge
        guard must not accept that change merely because it stayed on the same
        origin, but it can reuse the rule's already-reviewed article identity
        contract.  This helper performs no I/O and never exposes identifiers
        beyond the owning rule/capture boundary.
        """

        if not isinstance(identifiers, tuple) or any(
            not isinstance(identifier, Identifier) for identifier in identifiers
        ):
            raise TypeError("identifiers must contain neutral Identifier values")
        try:
            candidate = _normalized_url(value)
        except (TypeError, ValueError):
            return False
        if candidate.origin.text != self.landing_origin:
            return False
        return self._matches_article_identity(candidate, landing_url, identifiers)

    def _matches_article_identity(
        self,
        candidate: NormalizedURL,
        landing_url: str | None,
        identifiers: tuple[Identifier, ...],
    ) -> bool:
        landing: NormalizedURL | None = None
        if landing_url is not None:
            try:
                landing = _normalized_url(landing_url)
            except (TypeError, ValueError):
                return False
        return any(
            self._matches_identity_kind(kind, candidate, landing, identifiers)
            for kind in self.article_identity_kinds
        )

    def _matches_identity_kind(
        self,
        kind: BrowserArticleIdentityKind,
        candidate: NormalizedURL,
        landing: NormalizedURL | None,
        identifiers: tuple[Identifier, ...],
    ) -> bool:
        if kind is BrowserArticleIdentityKind.EXACT_LANDING:
            return (
                landing is not None
                and candidate.origin == landing.origin
                and candidate.path == landing.path
            )
        if kind is BrowserArticleIdentityKind.LANDING_PATH_STEM:
            return self._matches_landing_path_stem(candidate, landing)
        if kind is BrowserArticleIdentityKind.LANDING_PATH_TOKEN:
            return self._matches_landing_path_token(candidate, landing)
        if kind is BrowserArticleIdentityKind.IDENTIFIER_IN_PATH:
            candidate_path = _decoded_path(candidate)
            return any(
                identifier.namespace in self.article_id_namespaces
                and identifier.value.casefold() in candidate_path
                for identifier in identifiers
            )
        return False

    @staticmethod
    def _matches_landing_path_stem(
        candidate: NormalizedURL,
        landing: NormalizedURL | None,
    ) -> bool:
        if landing is None:
            return False
        landing_stem = _path_stem(_filename(landing))
        candidate_parts = tuple(
            _path_stem(part) for part in _decoded_path(candidate).split("/") if part
        )
        return bool(landing_stem and landing_stem in candidate_parts)

    @staticmethod
    def _matches_landing_path_token(
        candidate: NormalizedURL,
        landing: NormalizedURL | None,
    ) -> bool:
        if landing is None:
            return False
        landing_stem = _path_stem(_filename(landing))
        return len(landing_stem) >= 8 and landing_stem in _decoded_path(candidate)


@dataclass(frozen=True, slots=True)
class BrowserRuleCatalog:
    """A closed in-memory catalog with one current rule per reviewed landing origin."""

    rules: tuple[BrowserSiteRule, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.rules, tuple):
            raise TypeError("rules must be a tuple")
        if any(not isinstance(rule, BrowserSiteRule) for rule in self.rules):
            raise TypeError("rules must contain BrowserSiteRule values")
        rule_ids = tuple(rule.rule_id for rule in self.rules)
        origins = tuple(origin for rule in self.rules for origin in rule.recognized_landing_origins)
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
        return next((rule for rule in self.rules if rule.matches_origin(origin)), None)

    def match_url(self, value: str) -> BrowserSiteRule | None:
        """Find the rule whose exact landing origin owns a safe locator."""

        try:
            normalized = _normalized_url(value)
        except (TypeError, ValueError):
            return None
        return self.match_origin(normalized.origin.text)


__all__ = (
    "BrowserActionKind",
    "BrowserArticleIdentityKind",
    "BrowserCaptureDisposition",
    "BrowserPageMarker",
    "BrowserPageMarkerKind",
    "BrowserRuleAction",
    "BrowserRuleCatalog",
    "BrowserSiteRule",
)
