"""Pure publisher resolution and deterministic runtime acquisition planning."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, replace
from enum import Enum, unique
from typing import Final, Protocol, runtime_checkable
from urllib.parse import urlsplit, urlunsplit

from sciretriever.acquisition.access_profiles import (
    BrowserRateLimitGroup,
    PublisherAccessKey,
    PublisherAccessProfile,
    PublisherAccessProfileCatalog,
    normalize_profile_origin,
)
from sciretriever.acquisition.ports import AcquisitionRequest
from sciretriever.acquisition.routing import AcquisitionEvidence
from sciretriever.model.access import has_sensitive_query_parameter
from sciretriever.model.acquisition import AcquisitionPath
from sciretriever.model.literature import Identifier

_CONTROL_CHARACTER: Final[re.Pattern[str]] = re.compile(r"[\x00-\x1f\x7f]")
_STABLE_NAME: Final[re.Pattern[str]] = re.compile(
    r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
    re.ASCII,
)
_ROUTE_KEY: Final[re.Pattern[str]] = re.compile(
    r"^[a-z][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)+$",
    re.ASCII,
)
_DOI_PREFIX: Final[re.Pattern[str]] = re.compile(r"^10\.[0-9]{4,9}$", re.ASCII)
_TIER_ORDER: Final[dict[AcquisitionPath, int]] = {
    AcquisitionPath.PUBLIC: 0,
    AcquisitionPath.AUTHORIZED_PROVIDER_API: 1,
    AcquisitionPath.CONTROLLED_BROWSER: 2,
}


def _text(value: object, *, field_name: str, maximum: int = 512) -> str:
    if type(value) is not str:
        raise TypeError(f"{field_name} must be a string")
    candidate = value.strip()
    if not candidate or len(candidate) > maximum:
        raise ValueError(f"{field_name} is invalid")
    if _CONTROL_CHARACTER.search(candidate) is not None:
        raise ValueError(f"{field_name} must not contain control characters")
    return candidate


def _stable_name(value: object, *, field_name: str) -> str:
    candidate = _text(value, field_name=field_name, maximum=128).casefold()
    if _STABLE_NAME.fullmatch(candidate) is None:
        raise ValueError(f"{field_name} must be a stable token")
    return candidate


def _route_key(value: object) -> str:
    candidate = _text(value, field_name="route key", maximum=128).casefold()
    if _ROUTE_KEY.fullmatch(candidate) is None:
        raise ValueError("route key must be a namespaced stable token")
    return candidate


def _safe_runtime_url(value: object) -> str:
    candidate = _text(value, field_name="route hint URL", maximum=2048)
    try:
        parsed = urlsplit(candidate)
        port = parsed.port
    except (UnicodeError, ValueError):
        raise ValueError("route hint URL is invalid") from None
    if (
        parsed.scheme.casefold() not in {"http", "https"}
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise ValueError("route hint URL is invalid")
    try:
        if has_sensitive_query_parameter(parsed.query):
            raise ValueError("route hint URL must not contain sensitive query values")
    except (TypeError, ValueError):
        raise ValueError("route hint URL must not contain sensitive query values") from None
    scheme = parsed.scheme.casefold()
    host = parsed.hostname.encode("idna").decode("ascii").casefold()
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    default_port = 443 if scheme == "https" else 80
    authority = host if port in {None, default_port} else f"{host}:{port}"
    return urlunsplit((scheme, authority, parsed.path or "/", parsed.query, ""))


def _origin_from_url(value: str) -> str:
    parsed = urlsplit(_safe_runtime_url(value))
    host = parsed.hostname or ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    default_port = 443 if parsed.scheme == "https" else 80
    authority = host if parsed.port in {None, default_port} else f"{host}:{parsed.port}"
    return normalize_profile_origin(f"{parsed.scheme}://{authority}")


@unique
class ResolutionEvidenceKind(str, Enum):
    LANDING_ORIGIN = "landing-origin"
    ASSET_ORIGIN = "asset-origin"
    STABLE_PROVIDER_LOCATOR = "stable-provider-locator"
    PROVIDER_RECORD_IDENTITY = "provider-record-identity"
    DOI_PREFIX = "doi-prefix"
    PUBLISHER_TEXT = "publisher-text"


_STRONG_EVIDENCE_ORDER: Final[tuple[ResolutionEvidenceKind, ...]] = (
    ResolutionEvidenceKind.LANDING_ORIGIN,
    ResolutionEvidenceKind.ASSET_ORIGIN,
    ResolutionEvidenceKind.STABLE_PROVIDER_LOCATOR,
    ResolutionEvidenceKind.PROVIDER_RECORD_IDENTITY,
)
_WEAK_EVIDENCE: Final[frozenset[ResolutionEvidenceKind]] = frozenset(
    {ResolutionEvidenceKind.DOI_PREFIX, ResolutionEvidenceKind.PUBLISHER_TEXT}
)


@dataclass(frozen=True, slots=True)
class ResolutionEvidence:
    """One normalized, source-labelled access-resolution fact or weak hint."""

    kind: ResolutionEvidenceKind
    value: str
    source: str
    namespace: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.kind, ResolutionEvidenceKind):
            raise TypeError("kind must be ResolutionEvidenceKind")
        object.__setattr__(self, "source", _stable_name(self.source, field_name="source"))
        namespace = self.namespace
        if self.kind in {
            ResolutionEvidenceKind.LANDING_ORIGIN,
            ResolutionEvidenceKind.ASSET_ORIGIN,
        }:
            object.__setattr__(self, "value", normalize_profile_origin(self.value))
            if namespace is not None:
                raise ValueError("origin evidence does not accept a namespace")
        elif self.kind is ResolutionEvidenceKind.DOI_PREFIX:
            value = _text(self.value, field_name="DOI prefix", maximum=16).casefold()
            if _DOI_PREFIX.fullmatch(value) is None:
                raise ValueError("DOI prefix evidence is invalid")
            object.__setattr__(self, "value", value)
            if namespace is not None:
                raise ValueError("DOI prefix evidence does not accept a namespace")
        elif self.kind is ResolutionEvidenceKind.PUBLISHER_TEXT:
            object.__setattr__(
                self,
                "value",
                _text(self.value, field_name="publisher text", maximum=160).casefold(),
            )
            if namespace is not None:
                raise ValueError("publisher evidence does not accept a namespace")
        else:
            object.__setattr__(
                self,
                "value",
                _text(self.value, field_name="stable evidence value", maximum=256),
            )
            if namespace is None:
                raise ValueError("stable locator and record evidence require a namespace")
            object.__setattr__(
                self,
                "namespace",
                _stable_name(namespace, field_name="evidence namespace"),
            )

    @property
    def is_strong(self) -> bool:
        return self.kind not in _WEAK_EVIDENCE


@dataclass(frozen=True, slots=True)
class PublisherAccessResolution:
    """Deterministic result; an access key exists only for strong evidence."""

    access_key: str | None
    selected_evidence_kind: ResolutionEvidenceKind | None
    evidence: tuple[ResolutionEvidence, ...]
    weak_candidate_keys: tuple[str, ...] = ()
    conflict_keys: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.access_key is not None:
            object.__setattr__(self, "access_key", PublisherAccessKey(self.access_key))
        if self.selected_evidence_kind is not None and not isinstance(
            self.selected_evidence_kind,
            ResolutionEvidenceKind,
        ):
            raise TypeError("selected_evidence_kind must be ResolutionEvidenceKind or None")
        if not isinstance(self.evidence, tuple) or any(
            not isinstance(item, ResolutionEvidence) for item in self.evidence
        ):
            raise TypeError("evidence must contain ResolutionEvidence values")
        for field_name in ("weak_candidate_keys", "conflict_keys"):
            values = getattr(self, field_name)
            if not isinstance(values, tuple):
                raise TypeError(f"{field_name} must be a tuple")
            normalized = tuple(PublisherAccessKey(value) for value in values)
            if tuple(sorted(set(normalized))) != normalized:
                raise ValueError(f"{field_name} must be sorted and unique")
            object.__setattr__(self, field_name, normalized)
        if self.access_key is None and self.selected_evidence_kind is not None:
            raise ValueError("unresolved evidence cannot have a selected kind")
        if self.access_key is not None and (
            self.selected_evidence_kind not in _STRONG_EVIDENCE_ORDER or self.conflict_keys
        ):
            raise ValueError("a resolved access key requires one non-conflicting strong kind")

    @classmethod
    def unresolved(
        cls,
        *,
        evidence: tuple[ResolutionEvidence, ...] = (),
        weak_candidate_keys: tuple[str, ...] = (),
        conflict_keys: tuple[str, ...] = (),
    ) -> "PublisherAccessResolution":
        return cls(
            access_key=None,
            selected_evidence_kind=None,
            evidence=evidence,
            weak_candidate_keys=weak_candidate_keys,
            conflict_keys=conflict_keys,
        )

    @property
    def is_strong(self) -> bool:
        return self.access_key is not None

    @property
    def conflicted(self) -> bool:
        return bool(self.conflict_keys)


class PublisherAccessResolver:
    """Match normalized evidence without I/O or catalog-order guessing."""

    __slots__ = ("_catalog",)

    def __init__(self, catalog: PublisherAccessProfileCatalog) -> None:
        if not isinstance(catalog, PublisherAccessProfileCatalog):
            raise TypeError("catalog must be a PublisherAccessProfileCatalog")
        self._catalog = catalog

    @property
    def profile_catalog(self) -> PublisherAccessProfileCatalog:
        """Return the exact process-local catalog used for resolution."""

        return self._catalog

    def resolve(
        self,
        evidence: tuple[ResolutionEvidence, ...],
    ) -> PublisherAccessResolution:
        if not isinstance(evidence, tuple) or any(
            not isinstance(item, ResolutionEvidence) for item in evidence
        ):
            raise TypeError("evidence must contain ResolutionEvidence values")
        weak_candidates = self._weak_candidates(evidence)
        for kind in _STRONG_EVIDENCE_ORDER:
            matches = tuple(
                sorted(
                    {
                        profile.access_key
                        for item in evidence
                        if item.kind is kind
                        for profile in self._catalog
                        if _profile_matches(profile, item)
                    }
                )
            )
            if len(matches) == 1:
                return PublisherAccessResolution(
                    access_key=matches[0],
                    selected_evidence_kind=kind,
                    evidence=evidence,
                    weak_candidate_keys=weak_candidates,
                )
            if len(matches) > 1:
                return PublisherAccessResolution.unresolved(
                    evidence=evidence,
                    weak_candidate_keys=weak_candidates,
                    conflict_keys=matches,
                )
        return PublisherAccessResolution.unresolved(
            evidence=evidence,
            weak_candidate_keys=weak_candidates,
        )

    def _weak_candidates(
        self,
        evidence: tuple[ResolutionEvidence, ...],
    ) -> tuple[str, ...]:
        return tuple(
            sorted(
                {
                    profile.access_key
                    for item in evidence
                    if item.kind in _WEAK_EVIDENCE
                    for profile in self._catalog
                    if _profile_matches(profile, item)
                }
            )
        )


def _profile_matches(profile: PublisherAccessProfile, item: ResolutionEvidence) -> bool:
    if item.kind is ResolutionEvidenceKind.LANDING_ORIGIN:
        return item.value in profile.landing_origins
    if item.kind is ResolutionEvidenceKind.ASSET_ORIGIN:
        return item.value in profile.asset_origins
    if item.kind is ResolutionEvidenceKind.STABLE_PROVIDER_LOCATOR:
        return item.namespace in profile.stable_locator_namespaces
    if item.kind is ResolutionEvidenceKind.PROVIDER_RECORD_IDENTITY:
        return item.namespace in profile.provider_record_names
    if item.kind is ResolutionEvidenceKind.DOI_PREFIX:
        return item.value in profile.weak_doi_prefixes
    return item.value in profile.weak_publisher_names


@unique
class AccessRouteHintKind(str, Enum):
    CANONICAL_LANDING = "canonical-landing"
    STABLE_ARTICLE_ID = "stable-article-id"
    PDF_OBJECT_LOCATOR = "pdf-object-locator"
    ENTITLEMENT = "entitlement"


@dataclass(frozen=True, slots=True)
class AccessRouteHint:
    """Safe, work-item-local knowledge emitted by one route adapter."""

    kind: AccessRouteHintKind
    value: str
    source_route_key: str
    profile_access_key: str
    namespace: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.kind, AccessRouteHintKind):
            raise TypeError("kind must be AccessRouteHintKind")
        object.__setattr__(self, "source_route_key", _route_key(self.source_route_key))
        object.__setattr__(
            self,
            "profile_access_key",
            PublisherAccessKey(self.profile_access_key),
        )
        if self.kind in {
            AccessRouteHintKind.CANONICAL_LANDING,
            AccessRouteHintKind.PDF_OBJECT_LOCATOR,
        }:
            object.__setattr__(self, "value", _safe_runtime_url(self.value))
            if self.namespace is not None:
                raise ValueError("URL route hints do not accept a namespace")
        else:
            object.__setattr__(
                self,
                "value",
                _text(self.value, field_name="route hint value", maximum=256),
            )
            if self.namespace is not None:
                object.__setattr__(
                    self,
                    "namespace",
                    _stable_name(self.namespace, field_name="hint namespace"),
                )

    def __repr__(self) -> str:
        return (
            "AccessRouteHint("
            f"kind={self.kind.value!r}, source_route_key={self.source_route_key!r}, "
            f"profile_access_key={self.profile_access_key!r})"
        )

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("AccessRouteHint cannot be serialized")


@dataclass(frozen=True, slots=True)
class DoiLandingResolution:
    """One safe final DOI landing URL and its exact origin."""

    canonical_landing_url: str
    origin: str = ""

    def __post_init__(self) -> None:
        canonical = _safe_runtime_url(self.canonical_landing_url)
        object.__setattr__(self, "canonical_landing_url", canonical)
        derived_origin = _origin_from_url(canonical)
        if self.origin and normalize_profile_origin(self.origin) != derived_origin:
            raise ValueError("DOI landing origin must match its canonical URL")
        object.__setattr__(self, "origin", derived_origin)


@runtime_checkable
class DoiLandingResolutionPort(Protocol):
    """Resolve one DOI through the public Network boundary or return a miss."""

    def resolve(self, doi: Identifier) -> DoiLandingResolution | None: ...


@unique
class RouteCapability(str, Enum):
    PUBLIC_PROTOCOL = "public-protocol"
    DIRECT_PDF = "direct-pdf"
    MULTI_STEP_PDF_OBJECT = "multi-step-pdf-object"
    LOCATOR = "locator"
    ENTITLEMENT = "entitlement"
    STRUCTURED_FULL_TEXT = "structured-full-text"
    BROWSER_PDF = "browser-pdf"


@unique
class RouteReadiness(str, Enum):
    READY = "ready"
    DISABLED = "disabled"
    UNCONFIGURED = "unconfigured"
    TEMPORARILY_UNAVAILABLE = "temporarily-unavailable"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True, slots=True)
class RouteSpec:
    """One installed static capability considered by the runtime Planner."""

    route_key: str
    tier: AcquisitionPath
    capability: RouteCapability
    readiness: RouteReadiness
    profile_access_key: str | None = None
    quota_group: str | None = None
    risk_group: str | None = None
    allows_browser_after_unconfigured: bool = False
    required_identifier_namespaces: tuple[str, ...] = ()
    required_provider_record_names: tuple[str, ...] = ()
    requires_any_identifier: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "route_key", _route_key(self.route_key))
        if not isinstance(self.tier, AcquisitionPath):
            raise TypeError("tier must be AcquisitionPath")
        if not isinstance(self.capability, RouteCapability):
            raise TypeError("capability must be RouteCapability")
        if not isinstance(self.readiness, RouteReadiness):
            raise TypeError("readiness must be RouteReadiness")
        if self.profile_access_key is not None:
            object.__setattr__(
                self,
                "profile_access_key",
                PublisherAccessKey(self.profile_access_key),
            )
        self._normalize_groups()
        self._normalize_applicability()
        self._validate_tier_contract()

    def _normalize_groups(self) -> None:
        if self.quota_group is not None:
            object.__setattr__(
                self,
                "quota_group",
                _stable_name(self.quota_group, field_name="quota group"),
            )
        if self.risk_group is not None:
            object.__setattr__(self, "risk_group", BrowserRateLimitGroup(self.risk_group))
        if type(self.allows_browser_after_unconfigured) is not bool:
            raise TypeError("allows_browser_after_unconfigured must be a bool")

    def _validate_tier_contract(self) -> None:
        if self.tier is AcquisitionPath.CONTROLLED_BROWSER:
            if self.capability is not RouteCapability.BROWSER_PDF or self.risk_group is None:
                raise ValueError("Browser routes require Browser capability and a risk group")
        elif self.risk_group is not None:
            raise ValueError("only Browser routes accept a risk group")

    def _normalize_applicability(self) -> None:
        for field_name in (
            "required_identifier_namespaces",
            "required_provider_record_names",
        ):
            values = getattr(self, field_name)
            if not isinstance(values, tuple):
                raise TypeError(f"{field_name} must be a tuple")
            normalized = tuple(_stable_name(value, field_name=field_name) for value in values)
            if len(normalized) != len(set(normalized)):
                raise ValueError(f"{field_name} must be unique")
            object.__setattr__(self, field_name, normalized)
        if type(self.requires_any_identifier) is not bool:
            raise TypeError("requires_any_identifier must be a bool")


@dataclass(frozen=True, slots=True)
class AcquisitionPlan:
    """A deterministic, process-local plan; never a database fact."""

    revision: str
    resolution: PublisherAccessResolution
    routes: tuple[RouteSpec, ...]

    def __post_init__(self) -> None:
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", self.revision):
            raise ValueError("plan revision must be a SHA-256 identity")
        if not isinstance(self.resolution, PublisherAccessResolution):
            raise TypeError("resolution must be PublisherAccessResolution")
        if not isinstance(self.routes, tuple) or any(
            not isinstance(route, RouteSpec) for route in self.routes
        ):
            raise TypeError("routes must contain RouteSpec values")
        expected = tuple(sorted(self.routes, key=lambda route: _TIER_ORDER[route.tier]))
        if self.routes != expected:
            raise ValueError("routes must be grouped in tier order")
        keys = tuple(route.route_key for route in self.routes)
        if len(keys) != len(set(keys)):
            raise ValueError("plan route keys must be unique")

    def routes_for(self, tier: AcquisitionPath) -> tuple[RouteSpec, ...]:
        if not isinstance(tier, AcquisitionPath):
            raise TypeError("tier must be AcquisitionPath")
        return tuple(route for route in self.routes if route.tier is tier)

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("AcquisitionPlan cannot be serialized")


class AcquisitionPlanBuilder:
    """Filter installed capabilities by strong resolution and order by risk."""

    __slots__ = ("_catalog",)

    def __init__(self, catalog: PublisherAccessProfileCatalog) -> None:
        if not isinstance(catalog, PublisherAccessProfileCatalog):
            raise TypeError("catalog must be a PublisherAccessProfileCatalog")
        self._catalog = catalog

    @property
    def profile_catalog(self) -> PublisherAccessProfileCatalog:
        """Return the exact process-local catalog used to build plans."""

        return self._catalog

    def build(
        self,
        *,
        resolution: PublisherAccessResolution,
        route_specs: tuple[RouteSpec, ...],
        acquisition_evidence: AcquisitionEvidence | None = None,
    ) -> AcquisitionPlan:
        if not isinstance(resolution, PublisherAccessResolution):
            raise TypeError("resolution must be PublisherAccessResolution")
        if not isinstance(route_specs, tuple) or any(
            not isinstance(route, RouteSpec) for route in route_specs
        ):
            raise TypeError("route_specs must contain RouteSpec values")
        if acquisition_evidence is not None and not isinstance(
            acquisition_evidence,
            AcquisitionEvidence,
        ):
            raise TypeError("acquisition_evidence must be AcquisitionEvidence or None")
        selected: list[tuple[int, RouteSpec]] = []
        for index, route in enumerate(route_specs):
            if acquisition_evidence is not None and not _route_applies(
                route,
                acquisition_evidence,
            ):
                continue
            if route.profile_access_key is not None:
                if resolution.access_key != route.profile_access_key:
                    continue
                profile = self._catalog.get(route.profile_access_key)
                if profile is None:
                    raise ValueError("resolved profile is absent from the catalog")
                _validate_profile_route(profile, route)
            elif route.tier is AcquisitionPath.CONTROLLED_BROWSER:
                raise ValueError("generic Browser routes are forbidden")
            selected.append((index, route))
        routes = tuple(
            route
            for _index, route in sorted(
                selected,
                key=lambda item: (_TIER_ORDER[item[1].tier], item[0]),
            )
        )
        payload = repr(
            (
                resolution.access_key,
                resolution.selected_evidence_kind,
                resolution.weak_candidate_keys,
                resolution.conflict_keys,
                tuple(
                    (
                        route.route_key,
                        route.tier.value,
                        route.capability.value,
                        route.readiness.value,
                        route.profile_access_key,
                        route.quota_group,
                        route.risk_group,
                        route.allows_browser_after_unconfigured,
                        route.required_identifier_namespaces,
                        route.required_provider_record_names,
                        route.requires_any_identifier,
                    )
                    for route in routes
                ),
            )
        ).encode("utf-8")
        revision = f"sha256:{hashlib.sha256(payload).hexdigest()}"
        return AcquisitionPlan(revision=revision, resolution=resolution, routes=routes)


@unique
class DoiResolutionState(str, Enum):
    NOT_NEEDED = "not-needed"
    ELIGIBLE = "eligible"
    COMPLETED = "completed"


@dataclass(frozen=True, slots=True)
class AcquisitionPlanningSession:
    """One work item's current local evidence, hints, and plan revision."""

    request: AcquisitionRequest
    resolution: PublisherAccessResolution
    plan: AcquisitionPlan
    route_hints: tuple[AccessRouteHint, ...]
    doi_resolution_state: DoiResolutionState

    def __post_init__(self) -> None:
        if not isinstance(self.request, AcquisitionRequest):
            raise TypeError("request must be AcquisitionRequest")
        if not isinstance(self.resolution, PublisherAccessResolution):
            raise TypeError("resolution must be PublisherAccessResolution")
        if not isinstance(self.plan, AcquisitionPlan):
            raise TypeError("plan must be AcquisitionPlan")
        if not isinstance(self.route_hints, tuple) or any(
            not isinstance(hint, AccessRouteHint) for hint in self.route_hints
        ):
            raise TypeError("route_hints must contain AccessRouteHint values")
        if not isinstance(self.doi_resolution_state, DoiResolutionState):
            raise TypeError("doi_resolution_state must be DoiResolutionState")

    def __reduce__(self) -> str | tuple[object, ...]:
        raise TypeError("AcquisitionPlanningSession cannot be serialized")


class ProgressiveAcquisitionPlanner:
    """Build local plans and perform at most one explicit DOI public action."""

    __slots__ = ("_resolver", "_builder", "_route_specs", "_doi_landing")

    def __init__(
        self,
        *,
        resolver: PublisherAccessResolver,
        builder: AcquisitionPlanBuilder,
        route_specs: tuple[RouteSpec, ...],
        doi_landing_resolver: DoiLandingResolutionPort | None,
    ) -> None:
        if not isinstance(resolver, PublisherAccessResolver):
            raise TypeError("resolver must be PublisherAccessResolver")
        if not isinstance(builder, AcquisitionPlanBuilder):
            raise TypeError("builder must be AcquisitionPlanBuilder")
        if resolver.profile_catalog is not builder.profile_catalog:
            raise ValueError("resolver and builder must share one profile catalog")
        if not isinstance(route_specs, tuple) or any(
            not isinstance(route, RouteSpec) for route in route_specs
        ):
            raise TypeError("route_specs must contain RouteSpec values")
        if doi_landing_resolver is not None and not isinstance(
            doi_landing_resolver,
            DoiLandingResolutionPort,
        ):
            raise TypeError("doi_landing_resolver must implement DoiLandingResolutionPort")
        self._resolver = resolver
        self._builder = builder
        self._route_specs = route_specs
        self._doi_landing = doi_landing_resolver

    @property
    def profile_catalog(self) -> PublisherAccessProfileCatalog:
        """Return the catalog shared by this Planner's resolver and builder."""

        return self._resolver.profile_catalog

    def start(
        self,
        request: AcquisitionRequest,
        *,
        route_hints: tuple[AccessRouteHint, ...] = (),
    ) -> AcquisitionPlanningSession:
        if not isinstance(request, AcquisitionRequest):
            raise TypeError("request must be AcquisitionRequest")
        return self._build_session(
            request,
            route_hints=route_hints,
            doi_resolution_state=None,
        )

    def refresh_with_hints(
        self,
        session: AcquisitionPlanningSession,
        hints: tuple[AccessRouteHint, ...],
    ) -> AcquisitionPlanningSession:
        if not isinstance(session, AcquisitionPlanningSession):
            raise TypeError("session must be AcquisitionPlanningSession")
        if not isinstance(hints, tuple) or any(
            not isinstance(hint, AccessRouteHint) for hint in hints
        ):
            raise TypeError("hints must contain AccessRouteHint values")
        merged = list(session.route_hints)
        for hint in hints:
            if hint not in merged:
                merged.append(hint)
        return self._build_session(
            session.request,
            route_hints=tuple(merged),
            doi_resolution_state=session.doi_resolution_state,
        )

    def resolve_doi_landing(
        self,
        session: AcquisitionPlanningSession,
    ) -> AcquisitionPlanningSession:
        if not isinstance(session, AcquisitionPlanningSession):
            raise TypeError("session must be AcquisitionPlanningSession")
        if session.doi_resolution_state is not DoiResolutionState.ELIGIBLE:
            return session
        resolver = self._doi_landing
        if resolver is None:
            raise RuntimeError("DOI landing resolution is not assembled")
        doi = _single_doi(session.request)
        if doi is None:
            raise RuntimeError("eligible DOI resolution has no unique DOI")
        resolved = resolver.resolve(doi)
        if resolved is None:
            return self._build_session(
                session.request,
                route_hints=session.route_hints,
                doi_resolution_state=DoiResolutionState.COMPLETED,
            )
        enriched_request = replace(session.request, resolved_landing_origin=resolved.origin)
        profile_key = _profile_key_for_origin(self._resolver, resolved.origin)
        hints = session.route_hints
        if profile_key is not None:
            hint = AccessRouteHint(
                kind=AccessRouteHintKind.CANONICAL_LANDING,
                value=resolved.canonical_landing_url,
                source_route_key="public:doi-landing",
                profile_access_key=profile_key,
            )
            if hint not in hints:
                hints += (hint,)
        return self._build_session(
            enriched_request,
            route_hints=hints,
            doi_resolution_state=DoiResolutionState.COMPLETED,
        )

    def _build_session(
        self,
        request: AcquisitionRequest,
        *,
        route_hints: tuple[AccessRouteHint, ...],
        doi_resolution_state: DoiResolutionState | None,
    ) -> AcquisitionPlanningSession:
        from sciretriever.acquisition.routing import build_acquisition_evidence

        if not isinstance(request, AcquisitionRequest):
            raise TypeError("request must be AcquisitionRequest")
        evidence = build_resolution_evidence(
            build_acquisition_evidence(request),
            route_hints=route_hints,
        )
        resolution = self._resolver.resolve(evidence)
        plan = self._builder.build(
            resolution=resolution,
            route_specs=self._route_specs,
            acquisition_evidence=build_acquisition_evidence(request),
        )
        state = doi_resolution_state or self._initial_doi_state(request, resolution)
        return AcquisitionPlanningSession(
            request=request,
            resolution=resolution,
            plan=plan,
            route_hints=route_hints,
            doi_resolution_state=state,
        )

    def _initial_doi_state(
        self,
        request: AcquisitionRequest,
        resolution: PublisherAccessResolution,
    ) -> DoiResolutionState:
        needs_provider_resolution = any(
            route.profile_access_key is not None for route in self._route_specs
        )
        if resolution.is_strong or not needs_provider_resolution or _single_doi(request) is None:
            return DoiResolutionState.NOT_NEEDED
        return DoiResolutionState.ELIGIBLE


def _single_doi(request: AcquisitionRequest) -> Identifier | None:
    if not isinstance(request, AcquisitionRequest):
        raise TypeError("request must be AcquisitionRequest")
    dois = tuple(
        identifier
        for identifier in request.literature.metadata.identifiers
        if identifier.namespace == "doi"
    )
    return dois[0] if len(dois) == 1 else None


def _profile_key_for_origin(
    resolver: PublisherAccessResolver,
    origin: str,
) -> str | None:
    resolution = resolver.resolve(
        (
            ResolutionEvidence(
                kind=ResolutionEvidenceKind.LANDING_ORIGIN,
                value=origin,
                source="doi-landing",
            ),
        )
    )
    return resolution.access_key


def _validate_profile_route(profile: PublisherAccessProfile, route: RouteSpec) -> None:
    if route.tier is AcquisitionPath.PUBLIC:
        allowed = profile.public_route_keys
    elif route.tier is AcquisitionPath.AUTHORIZED_PROVIDER_API:
        allowed = profile.api_route_keys
    else:
        allowed = () if profile.browser_route_key is None else (profile.browser_route_key,)
        if route.risk_group != profile.browser_rate_limit_group:
            raise ValueError("Browser route risk group disagrees with its profile")
    if route.route_key not in allowed:
        raise ValueError("route is not declared by its access profile")


def _route_applies(route: RouteSpec, evidence: AcquisitionEvidence) -> bool:
    if route.requires_any_identifier and not evidence.identifiers:
        return False
    identifier_match = any(
        identifier.namespace in route.required_identifier_namespaces
        for identifier in evidence.identifiers
    )
    provider_match = any(
        identity.provider_name.casefold() in route.required_provider_record_names
        for identity in evidence.provider_record_identities
    )
    has_specific_requirement = bool(
        route.required_identifier_namespaces or route.required_provider_record_names
    )
    return not has_specific_requirement or identifier_match or provider_match


def build_resolution_evidence(
    acquisition_evidence: object,
    *,
    route_hints: tuple[AccessRouteHint, ...] = (),
) -> tuple[ResolutionEvidence, ...]:
    """Translate accepted neutral evidence and current hints without I/O."""

    from sciretriever.acquisition.routing import AcquisitionEvidence

    if not isinstance(acquisition_evidence, AcquisitionEvidence):
        raise TypeError("acquisition_evidence must be AcquisitionEvidence")
    if not isinstance(route_hints, tuple) or any(
        not isinstance(hint, AccessRouteHint) for hint in route_hints
    ):
        raise TypeError("route_hints must contain AccessRouteHint values")
    result = _strong_resolution_evidence(acquisition_evidence)
    _append_route_hint_evidence(result, route_hints)
    _append_weak_resolution_evidence(result, acquisition_evidence)
    unique: list[ResolutionEvidence] = []
    for item in result:
        if item not in unique:
            unique.append(item)
    return tuple(unique)


def _strong_resolution_evidence(acquisition_evidence: object) -> list[ResolutionEvidence]:
    from sciretriever.acquisition.routing import AcquisitionEvidence

    if not isinstance(acquisition_evidence, AcquisitionEvidence):
        raise TypeError("acquisition_evidence must be AcquisitionEvidence")
    result: list[ResolutionEvidence] = []
    if acquisition_evidence.resolved_landing_origin is not None:
        result.append(
            ResolutionEvidence(
                kind=ResolutionEvidenceKind.LANDING_ORIGIN,
                value=acquisition_evidence.resolved_landing_origin,
                source="doi-landing",
            )
        )
    for observed in acquisition_evidence.asset_hints:
        result.append(
            ResolutionEvidence(
                kind=ResolutionEvidenceKind.ASSET_ORIGIN,
                value=_origin_from_url(observed.hint.url),
                source="asset-hint",
            )
        )
    for locator in acquisition_evidence.stable_provider_locators:
        result.append(
            ResolutionEvidence(
                kind=ResolutionEvidenceKind.STABLE_PROVIDER_LOCATOR,
                value=locator.value,
                namespace=locator.namespace,
                source="literature-identifier",
            )
        )
    for identity in acquisition_evidence.provider_record_identities:
        result.append(
            ResolutionEvidence(
                kind=ResolutionEvidenceKind.PROVIDER_RECORD_IDENTITY,
                value=identity.record_id,
                namespace=identity.provider_name,
                source="metadata-observation",
            )
        )
    return result


def _append_route_hint_evidence(
    result: list[ResolutionEvidence],
    route_hints: tuple[AccessRouteHint, ...],
) -> None:
    for hint in route_hints:
        if hint.kind is AccessRouteHintKind.CANONICAL_LANDING:
            result.insert(
                0,
                ResolutionEvidence(
                    kind=ResolutionEvidenceKind.LANDING_ORIGIN,
                    value=_origin_from_url(hint.value),
                    source="route-hint",
                ),
            )
        elif hint.kind is AccessRouteHintKind.STABLE_ARTICLE_ID:
            result.append(
                ResolutionEvidence(
                    kind=ResolutionEvidenceKind.STABLE_PROVIDER_LOCATOR,
                    value=hint.value,
                    namespace=hint.namespace or hint.profile_access_key,
                    source="route-hint",
                )
            )


def _append_weak_resolution_evidence(
    result: list[ResolutionEvidence],
    acquisition_evidence: object,
) -> None:
    from sciretriever.acquisition.routing import AcquisitionEvidence

    if not isinstance(acquisition_evidence, AcquisitionEvidence):
        raise TypeError("acquisition_evidence must be AcquisitionEvidence")
    weak = acquisition_evidence.weak_hints
    for prefix in weak.doi_prefixes:
        result.append(
            ResolutionEvidence(
                kind=ResolutionEvidenceKind.DOI_PREFIX,
                value=prefix,
                source="literature-doi",
            )
        )
    if weak.publisher is not None:
        result.append(
            ResolutionEvidence(
                kind=ResolutionEvidenceKind.PUBLISHER_TEXT,
                value=weak.publisher,
                source="literature-metadata",
            )
        )


__all__ = (
    "AccessRouteHint",
    "AccessRouteHintKind",
    "AcquisitionPlan",
    "AcquisitionPlanBuilder",
    "AcquisitionPlanningSession",
    "DoiLandingResolution",
    "DoiLandingResolutionPort",
    "DoiResolutionState",
    "ProgressiveAcquisitionPlanner",
    "PublisherAccessResolution",
    "PublisherAccessResolver",
    "ResolutionEvidence",
    "ResolutionEvidenceKind",
    "RouteCapability",
    "RouteReadiness",
    "RouteSpec",
    "build_resolution_evidence",
)
