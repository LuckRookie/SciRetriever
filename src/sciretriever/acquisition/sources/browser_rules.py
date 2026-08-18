"""Local declarative rules for controlled Browser acquisition.

Rules in this module are deliberately small, immutable, and executable only
through the fixed observations and operations understood by
:mod:`acquisition.sources.browser`.  Page markers may use reviewed static CSS
selectors, exact-origin URL path prefixes, and response statuses.  They are
not a remote rule language: there is no loader, JavaScript surface, login form
description, Cookie/profile data, selector guessing, or fallback action
sequence.

The production catalog contains only rules whose page states, sessions,
scheduling, capture paths and offline fixtures have been verified end to end.
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
_DEFAULT_CAPTURE_PRIORITY: Final[tuple[BrowserCaptureKind, ...]] = (
    BrowserCaptureKind.VERIFIED_LOCATOR,
    BrowserCaptureKind.DOWNLOAD,
    BrowserCaptureKind.RESPONSE,
    BrowserCaptureKind.VIEWER,
    BrowserCaptureKind.POPUP,
)


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
class BrowserArticleIdentityKind(str, Enum):
    """Closed evidence comparisons that can bind a capture to one article."""

    EXACT_LANDING = "exact-landing"
    LANDING_PATH_STEM = "landing-path-stem"
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
    CHALLENGE_REQUIRED = "challenge-required"
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
    actions: tuple[BrowserRuleAction, ...] = field(default=(), repr=False)
    actions_require_entitlement: bool = False
    doi_pdf_url_template: str | None = field(default=None, repr=False)
    max_actions: int = _MAX_ACTIONS
    page_markers: tuple[BrowserPageMarker, ...] = field(default=(), repr=False)
    capture_url_prefixes: tuple[str, ...] = field(default=(), repr=False)
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
        self._validate_actions()
        self._normalize_document_rules()
        self._validate_document_rules()
        self._validate_page_markers()

    def _validate_actions(self) -> None:
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
        if type(self.actions_require_entitlement) is not bool:
            raise TypeError("actions_require_entitlement must be a bool")

    def _normalize_document_rules(self) -> None:
        if self.doi_pdf_url_template is not None:
            object.__setattr__(
                self,
                "doi_pdf_url_template",
                _doi_pdf_url_template(self.doi_pdf_url_template),
            )
        object.__setattr__(self, "capture_url_prefixes", _url_prefixes(self.capture_url_prefixes))
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
        if self.capture_url_prefixes and not self.article_identity_kinds:
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
        if any(
            _normalized_url(prefix).origin.text not in self.allowed_origins
            for prefix in (
                *self.capture_url_prefixes,
                *self.supplement_url_prefixes,
                *self.excluded_url_prefixes,
            )
        ):
            raise ValueError("document URL prefixes must use allowed rule origins")
        if set(self.supplement_url_prefixes) & set(self.excluded_url_prefixes):
            raise ValueError("supplement and excluded URL prefixes must be unambiguous")
        if set(self.supplement_filename_markers) & set(self.excluded_filename_markers):
            raise ValueError("supplement and excluded filename markers must be unambiguous")
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
            *self.allowed_origins,
            self.web_scope_provider_name,
            str(self.max_actions),
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
        if not _matches_url_prefix(candidate, self.capture_url_prefixes):
            return BrowserCaptureDisposition.REJECTED
        if not self._matches_article_identity(candidate, landing_url, identifiers):
            return BrowserCaptureDisposition.WRONG_ARTICLE
        return BrowserCaptureDisposition.PRIMARY

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
        for kind in self.article_identity_kinds:
            if kind is BrowserArticleIdentityKind.EXACT_LANDING and landing is not None:
                if candidate.origin == landing.origin and candidate.path == landing.path:
                    return True
            elif kind is BrowserArticleIdentityKind.LANDING_PATH_STEM and landing is not None:
                landing_stem = _path_stem(_filename(landing))
                candidate_parts = tuple(
                    _path_stem(part) for part in _decoded_path(candidate).split("/") if part
                )
                if landing_stem and landing_stem in candidate_parts:
                    return True
            elif kind is BrowserArticleIdentityKind.IDENTIFIER_IN_PATH:
                candidate_path = _decoded_path(candidate)
                if any(
                    identifier.namespace in self.article_id_namespaces
                    and identifier.value.casefold() in candidate_path
                    for identifier in identifiers
                ):
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


SPRINGERLINK_BROWSER_RULE: Final[BrowserSiteRule] = BrowserSiteRule(
    rule_id="springerlink-pdf",
    revision=4,
    landing_origin="https://link.springer.com",
    allowed_origins=(
        "https://link.springer.com",
        "https://static-content.springer.com",
        "https://idp.springer.com",
        "https://wayf.springernature.com",
    ),
    web_scope_provider_name="springerlink",
    actions=(
        BrowserRuleAction(
            kind=BrowserActionKind.CLICK,
            selector=(
                "a[href*='/content/pdf/'], "
                "a[data-track-action='download pdf'], "
                "a.c-pdf-download__link"
            ),
        ),
        BrowserRuleAction(
            kind=BrowserActionKind.WAIT_FOR_CAPTURE,
            capture_kind=BrowserCaptureKind.RESPONSE,
        ),
    ),
    actions_require_entitlement=True,
    doi_pdf_url_template="https://link.springer.com/content/pdf/{doi}.pdf",
    max_actions=2,
    page_markers=(
        BrowserPageMarker(
            marker_id="springerlink-entitled",
            kind=BrowserPageMarkerKind.ENTITLED,
            css_selectors=(
                "a[href*='/content/pdf/']",
                "a[data-track-action='download pdf']",
                "a.c-pdf-download__link",
            ),
        ),
        BrowserPageMarker(
            marker_id="springerlink-login-required",
            kind=BrowserPageMarkerKind.LOGIN_REQUIRED,
            url_prefixes=(
                "https://link.springer.com/login",
                "https://idp.springer.com/authorize",
            ),
        ),
        BrowserPageMarker(
            marker_id="springerlink-paywall",
            kind=BrowserPageMarkerKind.PAYWALL,
            css_selectors=("[data-test='access-options']",),
        ),
        BrowserPageMarker(
            marker_id="springerlink-mfa-required",
            kind=BrowserPageMarkerKind.MFA_REQUIRED,
            url_prefixes=("https://wayf.springernature.com/mfa",),
        ),
        BrowserPageMarker(
            marker_id="springerlink-challenge",
            kind=BrowserPageMarkerKind.CHALLENGE_REQUIRED,
            css_selectors=("#challenge-running",),
        ),
        BrowserPageMarker(
            marker_id="springerlink-rate-limited",
            kind=BrowserPageMarkerKind.RATE_LIMITED,
            response_statuses=(429,),
        ),
        BrowserPageMarker(
            marker_id="springerlink-ip-blocked",
            kind=BrowserPageMarkerKind.IP_BLOCKED,
            response_statuses=(403,),
        ),
        BrowserPageMarker(
            marker_id="springerlink-account-warning",
            kind=BrowserPageMarkerKind.ACCOUNT_WARNING,
            css_selectors=("[data-test='account-warning']",),
        ),
        BrowserPageMarker(
            marker_id="springerlink-not-found",
            kind=BrowserPageMarkerKind.NOT_FOUND,
            response_statuses=(404,),
        ),
    ),
    capture_url_prefixes=("https://link.springer.com/content/pdf/",),
    article_identity_kinds=(BrowserArticleIdentityKind.IDENTIFIER_IN_PATH,),
    article_id_namespaces=("doi",),
    supplement_url_prefixes=("https://static-content.springer.com/esm/",),
    supplement_filename_markers=("supplement", "mediaobjects"),
    excluded_url_prefixes=("https://link.springer.com/content/pdf/book-cover/",),
    excluded_filename_markers=("frontmatter", "sample"),
)

PRODUCTION_BROWSER_RULE_CATALOG: Final[BrowserRuleCatalog] = BrowserRuleCatalog(
    (SPRINGERLINK_BROWSER_RULE,)
)


__all__ = (
    "BrowserActionKind",
    "BrowserArticleIdentityKind",
    "BrowserCaptureDisposition",
    "BrowserPageMarker",
    "BrowserPageMarkerKind",
    "BrowserRuleAction",
    "BrowserRuleCatalog",
    "BrowserSiteRule",
    "PRODUCTION_BROWSER_RULE_CATALOG",
    "SPRINGERLINK_BROWSER_RULE",
)
