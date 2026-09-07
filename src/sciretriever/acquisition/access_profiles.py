"""Secret-free static profiles for publication and access platforms.

Profiles are Acquisition-owned knowledge.  They identify the party that
serves an article and describe only closed, reviewable routing facts.  An
optional Browser probe flag is diagnostic evidence, never an executable page
program or a prerequisite for generic Browser acquisition.  Profiles are
deliberately separate from Metadata Provider names and operation-local Browser
runtime material.
"""

from __future__ import annotations

import hashlib
import ipaddress
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import date
from enum import Enum, unique
from typing import ClassVar, Final
from urllib.parse import urlsplit

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
_EVIDENCE_REVISION: Final[re.Pattern[str]] = re.compile(
    r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$",
    re.ASCII,
)
_PROFILE_FIXTURE_PREFIX: Final[str] = "tests/fixtures/acquisition/profiles/"
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


def _evidence_revision(value: object) -> str:
    candidate = _plain_text(value, field_name="evidence revision", maximum=128).casefold()
    if _EVIDENCE_REVISION.fullmatch(candidate) is None:
        raise ValueError("evidence revision must be a stable token")
    return candidate


def _evidence_url(value: object) -> str:
    candidate = _plain_text(value, field_name="official evidence URL", maximum=1024)
    try:
        parsed = urlsplit(candidate)
        port = parsed.port
    except (UnicodeError, ValueError):
        raise ValueError("official evidence URL must be a static public HTTPS URL") from None
    if (
        parsed.scheme.casefold() != "https"
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or port not in {None, 443}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("official evidence URL must be a static public HTTPS URL")
    hostname = _hostname(parsed.hostname)
    path = parsed.path or "/"
    return f"https://{hostname}{path}"


def _notes_reference(value: object) -> str:
    candidate = _plain_text(value, field_name="Notes reference", maximum=256)
    if (
        not candidate.startswith("docs/notes/providers/")
        or not candidate.endswith(".md")
        or "\\" in candidate
        or any(part in {"", ".", ".."} for part in candidate.split("/"))
    ):
        raise ValueError("Notes reference must name one Provider Notes Markdown file")
    return candidate


def _fixture_reference(value: object) -> str:
    candidate = _plain_text(value, field_name="profile fixture reference", maximum=256)
    if (
        not candidate.startswith(_PROFILE_FIXTURE_PREFIX)
        or not candidate.endswith(".json")
        or "\\" in candidate
        or any(part in {"", ".", ".."} for part in candidate.split("/"))
    ):
        raise ValueError("profile fixture reference must name one acquisition profile JSON file")
    return candidate


@unique
class PolicyEvidence(str, Enum):
    """Provenance of a rate/access policy declaration."""

    OFFICIAL = "official"
    PROJECT_CONSERVATIVE = "project-conservative"
    UNVERIFIED = "unverified"


@unique
class ProfileProductionStatus(str, Enum):
    """Independent verification state for one access profile."""

    PRODUCTION_READY = "production-ready"
    FIXTURE_VERIFIED = "fixture-verified"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True, slots=True)
class PublisherAccessEvidence:
    """Uniform, secret-free evidence package for one access profile."""

    display_name: str
    product_name: str
    official_references: tuple[str, ...]
    access_terms_references: tuple[str, ...]
    rate_limit_references: tuple[str, ...]
    verification_date: date
    evidence_revision: str
    notes_reference: str
    fixture_reference: str

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "display_name",
            _plain_text(self.display_name, field_name="profile display name", maximum=160),
        )
        object.__setattr__(
            self,
            "product_name",
            _plain_text(self.product_name, field_name="profile product name", maximum=200),
        )
        for field_name in (
            "official_references",
            "access_terms_references",
            "rate_limit_references",
        ):
            references = _unique_tuple(
                getattr(self, field_name),
                field_name=field_name,
                normalize=_evidence_url,
            )
            if not references:
                raise ValueError(f"{field_name} must contain at least one official reference")
            object.__setattr__(self, field_name, references)
        if not isinstance(self.verification_date, date):
            raise TypeError("verification_date must be a date")
        object.__setattr__(
            self,
            "evidence_revision",
            _evidence_revision(self.evidence_revision),
        )
        object.__setattr__(self, "notes_reference", _notes_reference(self.notes_reference))
        object.__setattr__(
            self,
            "fixture_reference",
            _fixture_reference(self.fixture_reference),
        )


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
    browser_probe_enabled: bool
    policy_evidence: PolicyEvidence
    policy_revision: str
    production_status: ProfileProductionStatus
    evidence: PublisherAccessEvidence

    def __post_init__(self) -> None:
        object.__setattr__(self, "access_key", PublisherAccessKey(self.access_key))
        object.__setattr__(self, "platform_key", AccessPlatformKey(self.platform_key))
        self._normalize_match_fields()
        self._normalize_route_fields()
        self._validate_policy_fields()
        self._validate_profile_contract()

    def _normalize_match_fields(self) -> None:
        for field_name in ("landing_origins", "asset_origins"):
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

    def _validate_policy_fields(self) -> None:
        if not isinstance(self.policy_evidence, PolicyEvidence):
            raise TypeError("policy_evidence must be PolicyEvidence")
        if not isinstance(self.production_status, ProfileProductionStatus):
            raise TypeError("production_status must be ProfileProductionStatus")
        if not isinstance(self.evidence, PublisherAccessEvidence):
            raise TypeError("evidence must be PublisherAccessEvidence")
        if type(self.browser_probe_enabled) is not bool:
            raise TypeError("browser_probe_enabled must be a bool")
        object.__setattr__(
            self,
            "policy_revision",
            _plain_text(self.policy_revision, field_name="policy revision", maximum=64),
        )

    def _validate_profile_contract(self) -> None:
        if self.browser_probe_enabled and not self.landing_origins:
            raise ValueError("Browser probes require a landing origin")
        if self.production_status is ProfileProductionStatus.PRODUCTION_READY and (
            self.policy_evidence is PolicyEvidence.UNVERIFIED
        ):
            raise ValueError("a production-ready profile needs verified policy evidence")
        if self.production_status is ProfileProductionStatus.UNSUPPORTED and any(
            (
                self.public_route_keys,
                self.api_route_keys,
                self.browser_probe_enabled,
            )
        ):
            raise ValueError("an unsupported profile cannot declare routes or Browser probes")

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
                self.browser_probe_enabled,
                self.policy_evidence.value,
                self.policy_revision,
                self.production_status.value,
                (
                    self.evidence.display_name,
                    self.evidence.product_name,
                    self.evidence.official_references,
                    self.evidence.access_terms_references,
                    self.evidence.rate_limit_references,
                    self.evidence.verification_date.isoformat(),
                    self.evidence.evidence_revision,
                    self.evidence.notes_reference,
                    self.evidence.fixture_reference,
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
    "BrowserSessionKey",
    "PolicyEvidence",
    "ProfileProductionStatus",
    "PublisherAccessKey",
    "PublisherAccessEvidence",
    "PublisherAccessProfile",
    "PublisherAccessProfileCatalog",
    "normalize_profile_origin",
)
