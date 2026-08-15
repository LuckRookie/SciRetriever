"""Secret-free static profiles for publication and access platforms.

Profiles are Acquisition-owned knowledge.  They identify the party that
serves an article and describe only closed, reviewable capabilities and
Browser rules.  They are deliberately separate from Metadata Provider names
and from operator-managed Browser session material.
"""

from __future__ import annotations

import hashlib
import ipaddress
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from enum import Enum, unique
from typing import ClassVar, Final
from urllib.parse import urlsplit

from sciretriever.network.browser_scheduler import BrowserGroupPolicy

_CONTROL_CHARACTER: Final[re.Pattern[str]] = re.compile(r"[\x00-\x1f\x7f]")
_STABLE_IDENTITY: Final[re.Pattern[str]] = re.compile(
    r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
    re.ASCII,
)
_UUID: Final[re.Pattern[str]] = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.ASCII,
)
_DOI_PREFIX: Final[re.Pattern[str]] = re.compile(r"^10\.[0-9]{4,9}$", re.ASCII)
_ROUTE_KEY: Final[re.Pattern[str]] = re.compile(
    r"^[a-z][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)+$",
    re.ASCII,
)
_SENSITIVE_MARKERS: Final[frozenset[str]] = frozenset(
    {
        "api-key",
        "apikey",
        "authorization",
        "cookie",
        "credential",
        "password",
        "private-key",
        "secret",
        "signature",
        "token",
    }
)


def _plain_text(value: object, *, field_name: str, maximum: int = 256) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    candidate = value.strip()
    if not candidate:
        raise ValueError(f"{field_name} must be nonblank")
    if len(candidate) > maximum or _CONTROL_CHARACTER.search(candidate) is not None:
        raise ValueError(f"{field_name} is invalid")
    return candidate


class _AccessIdentity(str):
    """A stable, human-authored scheduling/catalog identity."""

    _field_name: ClassVar[str] = "access identity"

    def __new__(cls, value: object) -> "_AccessIdentity":
        candidate = _plain_text(value, field_name=cls._field_name, maximum=96).casefold()
        if (
            _STABLE_IDENTITY.fullmatch(candidate) is None
            or _UUID.fullmatch(candidate) is not None
            or candidate in _SENSITIVE_MARKERS
            or any(marker in candidate.split("-") for marker in _SENSITIVE_MARKERS)
        ):
            raise ValueError(f"{cls._field_name} must be a stable non-sensitive token")
        return str.__new__(cls, candidate)


class PublisherAccessKey(_AccessIdentity):
    _field_name = "publisher access key"


class AccessPlatformKey(_AccessIdentity):
    _field_name = "access platform key"


class BrowserRateLimitGroup(_AccessIdentity):
    _field_name = "browser rate-limit group"


class BrowserSessionKey(_AccessIdentity):
    _field_name = "browser session key"


def _hostname(value: str) -> str:
    try:
        normalized = value.encode("idna").decode("ascii").casefold()
    except UnicodeError:
        raise ValueError("profile origin hostname is invalid") from None
    if not normalized or normalized.endswith("."):
        raise ValueError("profile origin hostname is invalid")
    try:
        ipaddress.ip_address(normalized)
    except ValueError:
        labels = normalized.split(".")
        if len(labels) < 2 or any(
            not label
            or len(label) > 63
            or label.startswith("-")
            or label.endswith("-")
            or any(not (character.isalnum() or character == "-") for character in label)
            for label in labels
        ):
            raise ValueError("profile origin hostname is invalid") from None
        return normalized
    raise ValueError("profile origins must use named public hosts")


def normalize_profile_origin(value: object) -> str:
    """Return one exact HTTP(S) origin suitable for static profile matching."""

    candidate = _plain_text(value, field_name="profile origin", maximum=512)
    try:
        parsed = urlsplit(candidate)
        port = parsed.port
    except (UnicodeError, ValueError):
        raise ValueError("profile origin must be an exact HTTP(S) origin") from None
    scheme = parsed.scheme.casefold()
    if (
        scheme not in {"http", "https"}
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("profile origin must be an exact HTTP(S) origin")
    hostname = _hostname(parsed.hostname)
    default_port = 443 if scheme == "https" else 80
    authority = hostname if port in {None, default_port} else f"{hostname}:{port}"
    return f"{scheme}://{authority}"


def _unique_tuple(
    values: object,
    *,
    field_name: str,
    normalize: Callable[[object], str],
) -> tuple[str, ...]:
    if not isinstance(values, tuple):
        raise TypeError(f"{field_name} must be a tuple")
    result = tuple(normalize(value) for value in values)
    if len(result) != len(set(result)):
        raise ValueError(f"{field_name} must be unique")
    return result


def _stable_name(value: object) -> str:
    candidate = _plain_text(value, field_name="stable name", maximum=96).casefold()
    if _STABLE_IDENTITY.fullmatch(candidate) is None:
        raise ValueError("stable name must be a stable token")
    return candidate


def _route_key(value: object) -> str:
    candidate = _plain_text(value, field_name="route key", maximum=128).casefold()
    if _ROUTE_KEY.fullmatch(candidate) is None:
        raise ValueError("route key must be a namespaced stable token")
    return candidate


def _doi_prefix(value: object) -> str:
    candidate = _plain_text(value, field_name="DOI prefix", maximum=16).casefold()
    if _DOI_PREFIX.fullmatch(candidate) is None:
        raise ValueError("DOI prefix is invalid")
    return candidate


def _publisher_name(value: object) -> str:
    return _plain_text(value, field_name="publisher name", maximum=160).casefold()


def _rule_marker(value: object) -> str:
    return _plain_text(value, field_name="Browser rule marker", maximum=512)


@unique
class PolicyEvidence(str, Enum):
    """Provenance of a rate/access policy declaration."""

    OFFICIAL = "official"
    PROJECT_CONSERVATIVE = "project-conservative"
    UNVERIFIED = "unverified"


@unique
class ProfileProductionStatus(str, Enum):
    """Whether a profile may be assembled into the production registry."""

    PRODUCTION_READY = "production-ready"
    FIXTURE_VERIFIED = "fixture-verified"
    PUBLIC_API_ONLY = "public-api-only"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True, slots=True)
class BrowserRuleSet:
    """Closed page-state and PDF-ownership rules; never arbitrary script."""

    pdf_action_selectors: tuple[str, ...] = field(default=(), repr=False)
    login_markers: tuple[str, ...] = field(default=(), repr=False)
    entitlement_markers: tuple[str, ...] = field(default=(), repr=False)
    paywall_markers: tuple[str, ...] = field(default=(), repr=False)
    mfa_markers: tuple[str, ...] = field(default=(), repr=False)
    challenge_markers: tuple[str, ...] = field(default=(), repr=False)
    primary_pdf_url_markers: tuple[str, ...] = field(default=(), repr=False)
    supplementary_url_markers: tuple[str, ...] = field(default=(), repr=False)
    maximum_clicks: int = 1

    def __post_init__(self) -> None:
        for field_name in (
            "pdf_action_selectors",
            "login_markers",
            "entitlement_markers",
            "paywall_markers",
            "mfa_markers",
            "challenge_markers",
            "primary_pdf_url_markers",
            "supplementary_url_markers",
        ):
            normalized = _unique_tuple(
                getattr(self, field_name),
                field_name=field_name,
                normalize=_rule_marker,
            )
            object.__setattr__(self, field_name, normalized)
        if type(self.maximum_clicks) is not int or not 0 <= self.maximum_clicks <= 8:
            raise ValueError("maximum_clicks must be an integer from zero through eight")

    @property
    def can_initiate_download(self) -> bool:
        return bool(self.pdf_action_selectors or self.primary_pdf_url_markers)


@dataclass(frozen=True, slots=True)
class PublisherAccessProfile:
    """One deterministic, secret-free publication/access profile."""

    access_key: str
    platform_key: str
    landing_origins: tuple[str, ...]
    asset_origins: tuple[str, ...]
    stable_locator_namespaces: tuple[str, ...]
    provider_record_names: tuple[str, ...]
    weak_doi_prefixes: tuple[str, ...]
    weak_publisher_names: tuple[str, ...]
    public_route_keys: tuple[str, ...]
    api_route_keys: tuple[str, ...]
    browser_route_key: str | None
    browser_allowed_origins: tuple[str, ...]
    browser_rate_limit_group: str | None
    browser_session_key: str | None
    policy_evidence: PolicyEvidence
    policy_revision: str
    notes_reference: str
    production_status: ProfileProductionStatus
    browser_policy: BrowserGroupPolicy | None = None
    browser_rules: BrowserRuleSet = BrowserRuleSet()

    def __post_init__(self) -> None:
        object.__setattr__(self, "access_key", PublisherAccessKey(self.access_key))
        object.__setattr__(self, "platform_key", AccessPlatformKey(self.platform_key))
        self._normalize_match_fields()
        self._normalize_route_fields()
        self._normalize_browser_fields()
        self._validate_policy_fields()
        self._validate_browser_contract()

    def _normalize_match_fields(self) -> None:
        for field_name in ("landing_origins", "asset_origins", "browser_allowed_origins"):
            object.__setattr__(
                self,
                field_name,
                _unique_tuple(
                    getattr(self, field_name),
                    field_name=field_name,
                    normalize=normalize_profile_origin,
                ),
            )
        for field_name in ("stable_locator_namespaces", "provider_record_names"):
            object.__setattr__(
                self,
                field_name,
                _unique_tuple(
                    getattr(self, field_name),
                    field_name=field_name,
                    normalize=_stable_name,
                ),
            )

    def _normalize_route_fields(self) -> None:
        object.__setattr__(
            self,
            "weak_doi_prefixes",
            _unique_tuple(
                self.weak_doi_prefixes,
                field_name="weak_doi_prefixes",
                normalize=_doi_prefix,
            ),
        )
        object.__setattr__(
            self,
            "weak_publisher_names",
            _unique_tuple(
                self.weak_publisher_names,
                field_name="weak_publisher_names",
                normalize=_publisher_name,
            ),
        )
        for field_name in ("public_route_keys", "api_route_keys"):
            object.__setattr__(
                self,
                field_name,
                _unique_tuple(
                    getattr(self, field_name),
                    field_name=field_name,
                    normalize=_route_key,
                ),
            )
        if self.browser_route_key is not None:
            object.__setattr__(self, "browser_route_key", _route_key(self.browser_route_key))

    def _normalize_browser_fields(self) -> None:
        if self.browser_rate_limit_group is not None:
            object.__setattr__(
                self,
                "browser_rate_limit_group",
                BrowserRateLimitGroup(self.browser_rate_limit_group),
            )
        if self.browser_session_key is not None:
            object.__setattr__(
                self,
                "browser_session_key",
                BrowserSessionKey(self.browser_session_key),
            )

    def _validate_policy_fields(self) -> None:
        if not isinstance(self.policy_evidence, PolicyEvidence):
            raise TypeError("policy_evidence must be PolicyEvidence")
        if not isinstance(self.production_status, ProfileProductionStatus):
            raise TypeError("production_status must be ProfileProductionStatus")
        if not isinstance(self.browser_rules, BrowserRuleSet):
            raise TypeError("browser_rules must be BrowserRuleSet")
        if self.browser_policy is not None and not isinstance(
            self.browser_policy,
            BrowserGroupPolicy,
        ):
            raise TypeError("browser_policy must be BrowserGroupPolicy or None")
        object.__setattr__(
            self,
            "policy_revision",
            _plain_text(self.policy_revision, field_name="policy revision", maximum=64),
        )
        notes = _plain_text(self.notes_reference, field_name="Notes reference", maximum=256)
        if (
            not notes.startswith("docs/notes/providers/")
            or not notes.endswith(".md")
            or ".." in notes.split("/")
        ):
            raise ValueError("Notes reference must name one Provider Notes Markdown file")
        object.__setattr__(self, "notes_reference", notes)

    def _validate_browser_contract(self) -> None:
        browser_values_present = any(
            (
                self.browser_allowed_origins,
                self.browser_rate_limit_group is not None,
                self.browser_session_key is not None,
                self.browser_policy is not None,
                self.browser_rules != BrowserRuleSet(),
            )
        )
        if self.browser_route_key is None and browser_values_present:
            raise ValueError("Browser profile fields require a Browser route")
        if self.browser_route_key is not None and (
            not self.browser_allowed_origins
            or self.browser_rate_limit_group is None
            or self.browser_session_key is None
            or self.browser_policy is None
        ):
            raise ValueError(
                "Browser routes require origins, a rate group, a session key, and a policy"
            )
        if self.browser_policy is not None and (
            self.browser_policy.rate_limit_group != self.browser_rate_limit_group
            or self.browser_policy.policy_revision != self.policy_revision
        ):
            raise ValueError("Browser policy must match the profile group and revision")
        if self.production_status is ProfileProductionStatus.PRODUCTION_READY and (
            self.policy_evidence is PolicyEvidence.UNVERIFIED
            or (
                self.browser_route_key is not None
                and (
                    not self.browser_rules.can_initiate_download
                    or self.browser_policy is None
                    or not self.browser_policy.has_pacing
                )
            )
        ):
            raise ValueError("a production-ready Browser profile needs verified executable rules")
        if self.production_status is ProfileProductionStatus.PUBLIC_API_ONLY and (
            self.browser_route_key is not None
        ):
            raise ValueError("a public/API-only profile cannot declare a Browser route")

    @property
    def revision_hash(self) -> str:
        payload = repr(
            (
                self.access_key,
                self.platform_key,
                self.landing_origins,
                self.asset_origins,
                self.stable_locator_namespaces,
                self.provider_record_names,
                self.weak_doi_prefixes,
                self.weak_publisher_names,
                self.public_route_keys,
                self.api_route_keys,
                self.browser_route_key,
                self.browser_allowed_origins,
                self.browser_rate_limit_group,
                self.browser_session_key,
                None
                if self.browser_policy is None
                else (
                    self.browser_policy.rate_limit_group,
                    self.browser_policy.policy_revision,
                    self.browser_policy.minimum_start_interval,
                    self.browser_policy.rate_limit_cooldown,
                    self.browser_policy.runtime_failure_threshold,
                    self.browser_policy.max_concurrency,
                    self.browser_policy.maximum_starts_per_window,
                    self.browser_policy.window_seconds,
                    self.browser_policy.cooldown_after_completion,
                    self.browser_policy.failure_cooldown,
                ),
                self.policy_evidence.value,
                self.policy_revision,
                self.notes_reference,
                self.production_status.value,
                (
                    self.browser_rules.pdf_action_selectors,
                    self.browser_rules.login_markers,
                    self.browser_rules.entitlement_markers,
                    self.browser_rules.paywall_markers,
                    self.browser_rules.mfa_markers,
                    self.browser_rules.challenge_markers,
                    self.browser_rules.primary_pdf_url_markers,
                    self.browser_rules.supplementary_url_markers,
                    self.browser_rules.maximum_clicks,
                ),
            )
        ).encode("utf-8")
        return f"sha256:{hashlib.sha256(payload).hexdigest()}"


class PublisherAccessProfileCatalog:
    """Closed deterministic catalog with exact identity and origin indexes."""

    __slots__ = ("_profiles", "_by_access_key")

    def __init__(self, profiles: tuple[PublisherAccessProfile, ...]) -> None:
        if not isinstance(profiles, tuple):
            raise TypeError("profiles must be a tuple")
        if any(not isinstance(profile, PublisherAccessProfile) for profile in profiles):
            raise TypeError("profiles must contain PublisherAccessProfile values")
        keys = tuple(profile.access_key for profile in profiles)
        if len(keys) != len(set(keys)):
            raise ValueError("profile access keys must be unique")
        self._profiles = profiles
        self._by_access_key = {profile.access_key: profile for profile in profiles}

    def __iter__(self) -> Iterator[PublisherAccessProfile]:
        return iter(self._profiles)

    def __len__(self) -> int:
        return len(self._profiles)

    @property
    def profiles(self) -> tuple[PublisherAccessProfile, ...]:
        return self._profiles

    def get(self, access_key: str) -> PublisherAccessProfile | None:
        try:
            key = PublisherAccessKey(access_key)
        except (TypeError, ValueError):
            return None
        return self._by_access_key.get(key)


__all__ = (
    "AccessPlatformKey",
    "BrowserRateLimitGroup",
    "BrowserRuleSet",
    "BrowserSessionKey",
    "PolicyEvidence",
    "ProfileProductionStatus",
    "PublisherAccessKey",
    "PublisherAccessProfile",
    "PublisherAccessProfileCatalog",
    "normalize_profile_origin",
)
