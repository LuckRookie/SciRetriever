"""Closed Acquisition capability matrix and production route assembly.

This module is the A10 composition boundary below the root Bootstrap.  It
turns secret-free ordinary configuration and already-constructed shared
Network dependencies into a deterministic :class:`AcquisitionRouteRegistry`.
Construction performs no DNS, HTTP, Browser, resolver, storage, or user-data
operation.

The matrix deliberately distinguishes Provider capability mappings from
runtime routes.  One non-Provider ``direct`` adapter is shared by ordered views
that consume every accepted AssetHint: a global direct-file prefix, configured
Provider landing slots, then an unconfigured-history fallback.  Verified
authorized routes follow the complete public prefix.  Unsupported authorized
and Browser paths remain explicit mapping facts without being registered.
"""

from __future__ import annotations

import re
import threading
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Final

from sciretriever.acquisition.access_profiles import (
    PublisherAccessProfile,
    PublisherAccessProfileCatalog,
)
from sciretriever.acquisition.authorized import (
    PRODUCTION_AUTHORIZED_PROVIDER_CATALOG,
    UNSUPPORTED_AUTHORIZED_API_PROVIDER_KEYS,
    AuthorizedPdfSource,
    AuthorizedProviderClient,
    authorized_route_status,
)
from sciretriever.acquisition.outcomes import RouteExecutionResult
from sciretriever.acquisition.planning import (
    AcquisitionPlanBuilder,
    ProgressiveAcquisitionPlanner,
    PublisherAccessResolver,
    RouteCapability,
    RouteReadiness,
    RouteSpec,
)
from sciretriever.acquisition.profile_catalog import (
    PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG,
    PUBLISHER_ACCESS_VERIFICATION_MATRIX,
)
from sciretriever.acquisition.providers import (
    CoreAuthorizedPdfClient,
    ElsevierAuthorizedPdfClient,
    WileyAuthorizedPdfClient,
)
from sciretriever.acquisition.routes import (
    AcquisitionRouteRegistry,
    PdfRouteAdapter,
    RouteAdapterBinding,
    RouteExecutionContext,
)
from sciretriever.acquisition.routing import (
    build_acquisition_evidence,
)
from sciretriever.acquisition.sources import (
    CONTROLLED_BROWSER_PRODUCTION_STATUS,
    PRODUCTION_BROWSER_RULE_CATALOG,
    ArxivPdfSource,
    ConfiguredLocatorResolver,
    ConfiguredSciHubPdfSource,
    ControlledBrowserPdfSource,
    DirectPdfSource,
    DoiLandingResolver,
    EuropePmcPdfSource,
    PublicLocatorFetcher,
    UnpaywallPdfSource,
    WebAccessProfileResolver,
    configured_sci_hub_route_status,
)
from sciretriever.acquisition.sources.arxiv import (
    ACCESS_SCOPE as ARXIV_ACCESS_SCOPE,
)
from sciretriever.acquisition.sources.arxiv import (
    BASELINE_ACCESS_POLICY as ARXIV_ACCESS_POLICY,
)
from sciretriever.acquisition.sources.browser_rules import (
    BrowserRuleCatalog,
    BrowserSiteRule,
)
from sciretriever.acquisition.sources.europe_pmc import (
    ACCESS_SCOPE as EUROPE_PMC_ACCESS_SCOPE,
)
from sciretriever.acquisition.sources.europe_pmc import (
    BASELINE_ACCESS_POLICY as EUROPE_PMC_ACCESS_POLICY,
)
from sciretriever.acquisition.sources.unpaywall import (
    ACCESS_SCOPE as UNPAYWALL_ACCESS_SCOPE,
)
from sciretriever.acquisition.sources.unpaywall import (
    BASELINE_ACCESS_POLICY as UNPAYWALL_ACCESS_POLICY,
)
from sciretriever.configuration import CredentialLookup
from sciretriever.model.access import BrowserRequest, BrowserResult
from sciretriever.model.acquisition import (
    AcquisitionPath,
    AssetHint,
    AssetHintKind,
    AssetRole,
)
from sciretriever.model.configuration import Configuration, ProviderName
from sciretriever.model.metadata import MetadataObservation
from sciretriever.model.primitives import ProvenanceId, UtcTimestamp
from sciretriever.network.admission import (
    AccessCoordinator,
    AccessPolicy,
    AccessScope,
)
from sciretriever.network.browser import (
    BrowserBudget,
    BrowserCaptureGuard,
    BrowserClient,
    BrowserDestinationGuard,
    BrowserFlowSession,
)
from sciretriever.network.browser_sessions import BrowserSessionBroker
from sciretriever.network.http import HttpClient
from sciretriever.network.policy import PolicyError, normalize_url

_STABLE_TOKEN: Final[re.Pattern[str]] = re.compile(r"^[a-z0-9][a-z0-9-]{0,127}$")


class AcquisitionCapability(str, Enum):
    """One explicit mechanism by which a Provider can contribute a PDF."""

    GENERIC_ASSET_HINT = "generic-asset-hint"
    PUBLIC_PROTOCOL = "public-protocol"
    AUTHORIZED_PROVIDER_API = "authorized-provider-api"
    CONTROLLED_BROWSER = "controlled-browser"
    OPERATOR_LOCATOR = "operator-locator"


class _DirectSlice(str, Enum):
    """One ordered view over the single non-Provider DirectPdfSource."""

    DIRECT_PREFIX = "direct-prefix"
    PROVIDER_LANDING = "provider-landing"
    FALLBACK_LANDING = "fallback-landing"


ACQUISITION_PROVIDER_ORDER: Final[tuple[str, ...]] = (
    "arxiv",
    "crossref",
    "semantic-scholar",
    "openalex",
    "europe-pmc",
    "unpaywall",
    "elsevier",
    "springer",
    "wiley",
    "datacite",
    "core",
    "sci-hub",
)

# Exact hosts recorded by the checked Provider Notes as an API, landing, or
# content/download host owned by that Provider.  The table is deliberately
# closed: an aggregator locator is classified by its final host, never by
# metadata provenance, DOI prefix, publisher text, or a domain-suffix guess.
# API adapters still use their own provider/api scopes; these profiles apply
# when a host is consumed through ordinary landing/direct/Browser access.
PRODUCTION_WEB_HOSTS_BY_PROVIDER: Final[tuple[tuple[str, tuple[str, ...]], ...]] = (
    ("arxiv", ("arxiv.org", "export.arxiv.org")),
    ("europe-pmc", ("europepmc.org", "www.ebi.ac.uk")),
    (
        "elsevier",
        (
            "api.elsevier.com",
            "www.sciencedirect.com",
            "linkinghub.elsevier.com",
            "pdf.sciencedirectassets.com",
        ),
    ),
    (
        "springer",
        ("api.springernature.com",),
    ),
    (
        "springerlink",
        (
            "link.springer.com",
            "static-content.springer.com",
            "wayf.springernature.com",
        ),
    ),
    ("nature-portfolio", ("www.nature.com",)),
    ("wiley", ("onlinelibrary.wiley.com", "alm.wiley.com")),
    ("core", ("api.core.ac.uk", "core.ac.uk")),
    ("plos", ("journals.plos.org",)),
)

_PRODUCTION_WEB_POLICY: Final[AccessPolicy] = AccessPolicy(
    max_concurrency=1,
    min_start_interval=1.0,
)
_PLOS_WEB_POLICY: Final[AccessPolicy] = AccessPolicy(
    max_concurrency=1,
    min_start_interval=30.0,
)
_PRODUCTION_WEB_POLICY_BY_PROVIDER: Final[dict[str, AccessPolicy]] = {
    "plos": _PLOS_WEB_POLICY,
}

_AUTHORIZED_UNSUPPORTED: Final[frozenset[str]] = frozenset({"springer"})


class AcquisitionRegistryError(RuntimeError):
    """A stable and secret-free error raised before any Source I/O."""

    __slots__ = ("code", "provider_name")

    def __init__(self, code: str, provider_name: str = "acquisition") -> None:
        safe_code = (
            code
            if type(code) is str and _STABLE_TOKEN.fullmatch(code) is not None
            else "registry-invalid"
        )
        safe_provider = (
            provider_name
            if type(provider_name) is str and _STABLE_TOKEN.fullmatch(provider_name) is not None
            else "acquisition"
        )
        self.code = safe_code
        self.provider_name = safe_provider
        super().__init__(f"acquisition registry error [{safe_provider}:{safe_code}]")

    def __repr__(self) -> str:
        return f"AcquisitionRegistryError(code={self.code!r}, provider_name={self.provider_name!r})"


def _stable_name(value: object, *, field_name: str) -> str:
    if type(value) is not str or _STABLE_TOKEN.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be a stable token")
    return value


@dataclass(frozen=True, slots=True)
class AcquisitionProviderMapping:
    """One static Provider-to-mechanism mapping, including unsupported state."""

    capability: AcquisitionCapability
    source_name: str
    acquisition_path: AcquisitionPath
    production_implementation: type[object] | None
    production_available: bool
    failure_code: str | None
    uses_shared_network: bool = True
    uses_private_limiter: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.capability, AcquisitionCapability):
            raise TypeError("capability must be an AcquisitionCapability")
        object.__setattr__(
            self,
            "source_name",
            _stable_name(self.source_name, field_name="source_name"),
        )
        if not isinstance(self.acquisition_path, AcquisitionPath):
            raise TypeError("acquisition_path must be an AcquisitionPath")
        if self.production_implementation is not None and not isinstance(
            self.production_implementation,
            type,
        ):
            raise TypeError("production_implementation must be a type or None")
        for field_name, value in (
            ("production_available", self.production_available),
            ("uses_shared_network", self.uses_shared_network),
            ("uses_private_limiter", self.uses_private_limiter),
        ):
            if type(value) is not bool:
                raise TypeError(f"{field_name} must be a bool")
        if self.failure_code is not None:
            object.__setattr__(
                self,
                "failure_code",
                _stable_name(self.failure_code, field_name="failure_code"),
            )
        if self.production_available != (self.failure_code is None):
            raise ValueError("production availability and failure code disagree")


@dataclass(frozen=True, slots=True)
class AcquisitionProviderStatus:
    """Static mappings plus local ordinary/dependency readiness for one Provider."""

    provider_name: str
    mappings: tuple[AcquisitionProviderMapping, ...]
    enabled: bool
    ready: bool
    failure_code: str | None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "provider_name",
            _stable_name(self.provider_name, field_name="provider_name"),
        )
        if not isinstance(self.mappings, tuple) or not self.mappings:
            raise ValueError("mappings must be a nonempty tuple")
        if any(not isinstance(item, AcquisitionProviderMapping) for item in self.mappings):
            raise TypeError("mappings must contain AcquisitionProviderMapping values")
        if type(self.enabled) is not bool or type(self.ready) is not bool:
            raise TypeError("enabled and ready must be bool values")
        if self.failure_code is not None:
            object.__setattr__(
                self,
                "failure_code",
                _stable_name(self.failure_code, field_name="failure_code"),
            )
        if self.ready != (self.failure_code is None):
            raise ValueError("readiness and failure code disagree")

    def __repr__(self) -> str:
        mechanisms = tuple(mapping.capability.value for mapping in self.mappings)
        return (
            "AcquisitionProviderStatus("
            f"provider_name={self.provider_name!r}, mappings={mechanisms!r}, "
            f"enabled={self.enabled!r}, ready={self.ready!r}, "
            f"failure_code={self.failure_code!r})"
        )


@dataclass(frozen=True, slots=True)
class AcquisitionAssemblyDependencies:
    """Shared process-local objects supplied later by the production Bootstrap."""

    http_client: HttpClient = field(repr=False)
    access_coordinator: AccessCoordinator = field(repr=False)
    web_access_profile_resolver: WebAccessProfileResolver = field(repr=False)
    provenance_id_factory: Callable[[], ProvenanceId] = field(repr=False)
    clock: Callable[[], UtcTimestamp] = field(repr=False)
    browser_session_broker: BrowserSessionBroker = field(repr=False)
    credentials: CredentialLookup | None = field(default=None, repr=False)
    cancel_event: threading.Event | None = field(default=None, repr=False)
    configured_sci_hub_resolver: ConfiguredLocatorResolver | None = field(
        default=None,
        repr=False,
    )
    browser_client: BrowserClient | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if not isinstance(self.http_client, HttpClient):
            raise TypeError("http_client must be an HttpClient")
        if not isinstance(self.access_coordinator, AccessCoordinator):
            raise TypeError("access_coordinator must be an AccessCoordinator")
        if not isinstance(self.web_access_profile_resolver, WebAccessProfileResolver):
            raise TypeError("web_access_profile_resolver must be a WebAccessProfileResolver")
        if not callable(self.provenance_id_factory) or not callable(self.clock):
            raise TypeError("acquisition assembly factories must be callable")
        if not isinstance(self.browser_session_broker, BrowserSessionBroker):
            raise TypeError("browser_session_broker must be a BrowserSessionBroker")
        if self.credentials is not None and not isinstance(self.credentials, CredentialLookup):
            raise TypeError("credentials must implement CredentialLookup or be None")
        if self.cancel_event is not None and not isinstance(
            self.cancel_event,
            threading.Event,
        ):
            raise TypeError("cancel_event must be a threading.Event or None")
        if self.browser_client is not None and not isinstance(
            self.browser_client,
            BrowserClient,
        ):
            raise TypeError("browser_client must be a BrowserClient or None")


@dataclass(frozen=True, slots=True)
class AcquisitionRegistry:
    """Deterministic capability directory and Planner for production assembly."""

    statuses: tuple[AcquisitionProviderStatus, ...]
    route_registry: AcquisitionRouteRegistry = field(repr=False)
    planner: ProgressiveAcquisitionPlanner = field(repr=False)

    def __post_init__(self) -> None:
        if not isinstance(self.statuses, tuple) or any(
            not isinstance(item, AcquisitionProviderStatus) for item in self.statuses
        ):
            raise TypeError("statuses must contain AcquisitionProviderStatus values")
        if not isinstance(self.route_registry, AcquisitionRouteRegistry):
            raise TypeError("route_registry must be an AcquisitionRouteRegistry")
        if not isinstance(self.planner, ProgressiveAcquisitionPlanner):
            raise TypeError("planner must be a ProgressiveAcquisitionPlanner")
        if self.planner.profile_catalog is not self.route_registry.profile_catalog:
            raise ValueError("registry and Planner must share one profile catalog")
        validate_acquisition_provider_matrix(self.statuses)

    @property
    def profile_catalog(self) -> PublisherAccessProfileCatalog:
        """Return the exact catalog shared by route selection and planning."""

        return self.route_registry.profile_catalog

    def __repr__(self) -> str:
        routes = tuple(binding.spec.route_key for binding in self.route_registry.bindings)
        return f"AcquisitionRegistry(routes={routes!r})"


def _mapping(
    capability: AcquisitionCapability,
    source_name: str,
    acquisition_path: AcquisitionPath,
    implementation: type[object] | None,
    *,
    failure_code: str | None = None,
) -> AcquisitionProviderMapping:
    return AcquisitionProviderMapping(
        capability=capability,
        source_name=source_name,
        acquisition_path=acquisition_path,
        production_implementation=implementation,
        production_available=failure_code is None,
        failure_code=failure_code,
    )


def _generic_mapping() -> AcquisitionProviderMapping:
    return _mapping(
        AcquisitionCapability.GENERIC_ASSET_HINT,
        "direct",
        AcquisitionPath.PUBLIC,
        DirectPdfSource,
    )


def _authorized_unsupported(provider_name: str) -> AcquisitionProviderMapping:
    return _mapping(
        AcquisitionCapability.AUTHORIZED_PROVIDER_API,
        provider_name,
        AcquisitionPath.AUTHORIZED_PROVIDER_API,
        None,
        failure_code="authorized-api-unsupported",
    )


def _authorized_supported(provider_name: str) -> AcquisitionProviderMapping:
    return _mapping(
        AcquisitionCapability.AUTHORIZED_PROVIDER_API,
        provider_name,
        AcquisitionPath.AUTHORIZED_PROVIDER_API,
        AuthorizedPdfSource,
    )


def _browser_unavailable() -> AcquisitionProviderMapping:
    return _mapping(
        AcquisitionCapability.CONTROLLED_BROWSER,
        "controlled-browser",
        AcquisitionPath.CONTROLLED_BROWSER,
        ControlledBrowserPdfSource,
        failure_code="browser-production-unavailable",
    )


def _browser_supported() -> AcquisitionProviderMapping:
    return _mapping(
        AcquisitionCapability.CONTROLLED_BROWSER,
        "controlled-browser",
        AcquisitionPath.CONTROLLED_BROWSER,
        ControlledBrowserPdfSource,
    )


_FIXED_MAPPINGS: Final[dict[str, tuple[AcquisitionProviderMapping, ...]]] = {
    "arxiv": (
        _generic_mapping(),
        _mapping(
            AcquisitionCapability.PUBLIC_PROTOCOL,
            "arxiv",
            AcquisitionPath.PUBLIC,
            ArxivPdfSource,
        ),
    ),
    "crossref": (_generic_mapping(),),
    "semantic-scholar": (_generic_mapping(),),
    "openalex": (_generic_mapping(),),
    "europe-pmc": (
        _generic_mapping(),
        _mapping(
            AcquisitionCapability.PUBLIC_PROTOCOL,
            "europe-pmc",
            AcquisitionPath.PUBLIC,
            EuropePmcPdfSource,
        ),
    ),
    "unpaywall": (
        _mapping(
            AcquisitionCapability.PUBLIC_PROTOCOL,
            "unpaywall",
            AcquisitionPath.PUBLIC,
            UnpaywallPdfSource,
        ),
    ),
    "elsevier": (
        _generic_mapping(),
        _authorized_supported("elsevier"),
        _browser_unavailable(),
    ),
    "springer": (
        _generic_mapping(),
        _authorized_unsupported("springer"),
        _browser_supported(),
    ),
    "wiley": (
        _authorized_supported("wiley"),
        _browser_unavailable(),
    ),
    "datacite": (_generic_mapping(),),
    "core": (
        _generic_mapping(),
        _authorized_supported("core"),
    ),
    "sci-hub": (
        _mapping(
            AcquisitionCapability.OPERATOR_LOCATOR,
            "sci-hub",
            AcquisitionPath.PUBLIC,
            ConfiguredSciHubPdfSource,
        ),
    ),
}


def _readiness_failure(
    provider_name: str,
    configuration: Configuration,
    configured_resolver: ConfiguredLocatorResolver | None,
) -> str | None:
    mappings = _FIXED_MAPPINGS[provider_name]
    if not any(mapping.production_available for mapping in mappings):
        return "missing-production-route"
    if provider_name == ProviderName.UNPAYWALL.value:
        if configuration.sources.acquisition.unpaywall is None:
            return "missing-ordinary-parameter"
    if provider_name == ProviderName.SCI_HUB.value:
        try:
            status = configured_sci_hub_route_status(configured_resolver)
        except (TypeError, ValueError):
            raise AcquisitionRegistryError(
                "configured-resolver-invalid",
                provider_name,
            ) from None
        if status.readiness is not RouteReadiness.READY:
            return "missing-configured-resolver"
    return None


def acquisition_provider_statuses(
    configuration: Configuration,
    *,
    configured_sci_hub_resolver: ConfiguredLocatorResolver | None = None,
) -> tuple[AcquisitionProviderStatus, ...]:
    """Compute the full local matrix without constructing a client or probing."""

    if not isinstance(configuration, Configuration):
        raise AcquisitionRegistryError("configuration-invalid")
    enabled = frozenset(provider.value for provider in configuration.sources.acquisition.providers)
    statuses = tuple(
        AcquisitionProviderStatus(
            provider_name=provider_name,
            mappings=_FIXED_MAPPINGS[provider_name],
            enabled=provider_name in enabled,
            ready=(
                failure_code := _readiness_failure(
                    provider_name,
                    configuration,
                    configured_sci_hub_resolver,
                )
            )
            is None,
            failure_code=failure_code,
        )
        for provider_name in ACQUISITION_PROVIDER_ORDER
    )
    validate_acquisition_provider_matrix(statuses)
    return statuses


def production_web_access_profile_resolver() -> WebAccessProfileResolver:
    """Build the closed production host-to-provider/web admission table."""

    profiles: dict[str, tuple[AccessScope, AccessPolicy]] = {}
    publisher_access_keys = frozenset(
        profile.access_key for profile in PUBLISHER_ACCESS_VERIFICATION_MATRIX.profiles
    )
    for provider_name, hostnames in PRODUCTION_WEB_HOSTS_BY_PROVIDER:
        if (
            provider_name not in ACQUISITION_PROVIDER_ORDER
            and provider_name not in publisher_access_keys
        ):
            raise AcquisitionRegistryError("web-profile-provider-mismatch")
        scope = AccessScope(provider_name, "web")
        policy = _PRODUCTION_WEB_POLICY_BY_PROVIDER.get(
            provider_name,
            _PRODUCTION_WEB_POLICY,
        )
        for hostname in hostnames:
            if hostname in profiles:
                raise AcquisitionRegistryError(
                    "web-profile-host-duplicate",
                    provider_name,
                )
            profiles[hostname] = (scope, policy)
    try:
        return WebAccessProfileResolver(profiles)
    except (TypeError, ValueError):
        raise AcquisitionRegistryError("web-profile-invalid") from None


def _validate_external_catalogs() -> None:
    if set(PRODUCTION_AUTHORIZED_PROVIDER_CATALOG) != {"core", "elsevier", "wiley"}:
        raise AcquisitionRegistryError("authorized-catalog-mismatch")
    if UNSUPPORTED_AUTHORIZED_API_PROVIDER_KEYS != _AUTHORIZED_UNSUPPORTED:
        raise AcquisitionRegistryError("authorized-unsupported-mismatch")
    expected_profile_routes = {
        "core-open-access": ((), ("api:core",), None),
        "elsevier-sciencedirect": ((), ("api:elsevier-article-object",), None),
        "springerlink": ((), (), "browser:springerlink"),
        "wiley-online-library": ((), ("api:wiley-tdm-v1",), None),
    }
    actual_profile_routes = {
        profile.access_key: (
            profile.public_route_keys,
            profile.api_route_keys,
            profile.browser_route_key,
        )
        for profile in PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG
    }
    if actual_profile_routes != expected_profile_routes:
        raise AcquisitionRegistryError("profile-catalog-mismatch")
    if (
        PRODUCTION_BROWSER_RULE_CATALOG.rules
        != PUBLISHER_ACCESS_VERIFICATION_MATRIX.production_browser_rules.rules
    ):
        raise AcquisitionRegistryError("browser-catalog-mismatch")
    expected_browser_readiness = (
        RouteReadiness.READY
        if PRODUCTION_BROWSER_RULE_CATALOG.rules
        else RouteReadiness.UNSUPPORTED
    )
    if CONTROLLED_BROWSER_PRODUCTION_STATUS.readiness is not expected_browser_readiness:
        raise AcquisitionRegistryError("browser-readiness-mismatch")


def _validate_matrix_names(statuses: tuple[AcquisitionProviderStatus, ...]) -> None:
    if not isinstance(statuses, tuple) or any(
        not isinstance(status, AcquisitionProviderStatus) for status in statuses
    ):
        raise AcquisitionRegistryError("matrix-invalid")
    names = tuple(status.provider_name for status in statuses)
    if names != ACQUISITION_PROVIDER_ORDER:
        if len(names) != len(set(names)):
            raise AcquisitionRegistryError("duplicate-provider")
        if set(names) != set(ACQUISITION_PROVIDER_ORDER):
            raise AcquisitionRegistryError("missing-provider")
        raise AcquisitionRegistryError("provider-order-mismatch")


def _validate_provider_status(status: AcquisitionProviderStatus) -> None:
    expected = _FIXED_MAPPINGS[status.provider_name]
    if status.mappings != expected:
        raise AcquisitionRegistryError("mapping-mismatch", status.provider_name)
    for mapping in status.mappings:
        if not mapping.uses_shared_network:
            raise AcquisitionRegistryError("network-bypass", status.provider_name)
        if mapping.uses_private_limiter:
            raise AcquisitionRegistryError(
                "private-limiter-forbidden",
                status.provider_name,
            )
    if status.ready != (status.failure_code is None):
        raise AcquisitionRegistryError("readiness-state-invalid", status.provider_name)


def validate_acquisition_provider_matrix(
    statuses: tuple[AcquisitionProviderStatus, ...],
) -> None:
    """Reject missing, reordered, duplicated, inferred, or Network-bypassing mappings."""

    _validate_external_catalogs()
    _validate_matrix_names(statuses)
    for status in statuses:
        _validate_provider_status(status)


def _eligible_primary_hint(hint: AssetHint) -> bool:
    return hint.asset_role is None or hint.asset_role is AssetRole.PRIMARY_PDF


def _canonical_hint_url(hint: AssetHint) -> str | None:
    try:
        return normalize_url(hint.url).url
    except (PolicyError, TypeError, ValueError):
        return None


def _direct_hint_urls(hints: Iterable[AssetHint]) -> frozenset[str]:
    return frozenset(
        canonical
        for hint in hints
        if hint.kind is AssetHintKind.DIRECT_FILE and _eligible_primary_hint(hint)
        if (canonical := _canonical_hint_url(hint)) is not None
    )


def _excluded_direct_providers(value: object) -> frozenset[str]:
    if not isinstance(value, tuple):
        raise TypeError("excluded_provider_names must be a tuple")
    if len(set(value)) != len(value):
        raise ValueError("excluded_provider_names must be unique")
    if any(provider not in ACQUISITION_PROVIDER_ORDER for provider in value):
        raise ValueError("excluded_provider_names contains an unsupported Provider")
    return frozenset(value)


def _validated_direct_slice_provider(
    direct_slice: _DirectSlice,
    provider_name: str | None,
    excluded_provider_names: frozenset[str],
) -> str | None:
    if direct_slice is _DirectSlice.PROVIDER_LANDING:
        if provider_name not in ACQUISITION_PROVIDER_ORDER:
            raise ValueError("provider landing slices require one supported Provider")
        if excluded_provider_names:
            raise ValueError("provider landing slices cannot exclude Providers")
        return provider_name
    if provider_name is not None:
        raise ValueError("only provider landing slices may name a Provider")
    if direct_slice is not _DirectSlice.FALLBACK_LANDING and excluded_provider_names:
        raise ValueError("only fallback landing slices may exclude Providers")
    return None


class _OrderedDirectRoute:
    """An ordered evidence slice over one shared, non-Provider direct adapter."""

    __slots__ = (
        "_direct_source",
        "_excluded_provider_names",
        "_provider_name",
        "_slice",
    )

    def __init__(
        self,
        *,
        direct_source: DirectPdfSource,
        direct_slice: _DirectSlice,
        provider_name: str | None = None,
        excluded_provider_names: tuple[str, ...] = (),
    ) -> None:
        if not isinstance(direct_source, DirectPdfSource):
            raise TypeError("direct_source must be a DirectPdfSource")
        if not isinstance(direct_slice, _DirectSlice):
            raise TypeError("direct_slice must be a _DirectSlice")
        excluded = _excluded_direct_providers(excluded_provider_names)
        provider = _validated_direct_slice_provider(direct_slice, provider_name, excluded)
        self._direct_source = direct_source
        self._slice = direct_slice
        self._provider_name = provider
        self._excluded_provider_names = excluded

    @property
    def source_name(self) -> str:
        return self._direct_source.source_name

    @property
    def acquisition_path(self) -> AcquisitionPath:
        return self._direct_source.acquisition_path

    @property
    def route_key(self) -> str:
        if self._slice is _DirectSlice.DIRECT_PREFIX:
            return "public:direct"
        if self._slice is _DirectSlice.PROVIDER_LANDING:
            return f"public:landing-{self._provider_name}"
        return "public:landing-fallback"

    def execute(self, context: RouteExecutionContext) -> Iterable[RouteExecutionResult]:
        if not isinstance(context, RouteExecutionContext):
            raise TypeError("context must be RouteExecutionContext")
        direct_urls = _direct_hint_urls(
            hint for observation in context.request.observations for hint in observation.asset_hints
        )
        observations = self._filtered_observations(
            context.request.observations,
            direct_urls=direct_urls,
        )
        filtered_request = replace(context.request, observations=observations)
        filtered_evidence = build_acquisition_evidence(filtered_request)
        if not filtered_evidence.asset_hints:
            return (RouteExecutionResult.normal_miss(),)
        return self._direct_source.execute(
            RouteExecutionContext(
                request=filtered_request,
                evidence=filtered_evidence,
                route_hints=context.route_hints,
                candidate_keys=context.candidate_keys,
                cancel_event=context.cancel_event,
            )
        )

    def _filtered_observations(
        self,
        observations: tuple[MetadataObservation, ...],
        *,
        direct_urls: frozenset[str],
    ) -> tuple[MetadataObservation, ...]:
        return tuple(
            observation.model_copy(
                update={
                    "asset_hints": tuple(
                        hint
                        for hint in observation.asset_hints
                        if self._includes(
                            source_name=observation.provenance.source_name,
                            hint=hint,
                            direct_urls=direct_urls,
                        )
                    )
                }
            )
            for observation in observations
        )

    def _includes(
        self,
        *,
        source_name: str,
        hint: AssetHint,
        direct_urls: frozenset[str],
    ) -> bool:
        if not _eligible_primary_hint(hint):
            return False
        canonical = _canonical_hint_url(hint)
        duplicates_direct = canonical is not None and canonical in direct_urls
        if self._slice is _DirectSlice.DIRECT_PREFIX:
            return hint.kind is AssetHintKind.DIRECT_FILE or (
                hint.kind is AssetHintKind.LANDING_PAGE and duplicates_direct
            )
        if hint.kind is not AssetHintKind.LANDING_PAGE or duplicates_direct:
            return False
        normalized_source = source_name.casefold()
        if self._slice is _DirectSlice.PROVIDER_LANDING:
            return normalized_source == self._provider_name
        return normalized_source not in self._excluded_provider_names


class _SessionBoundBrowserRunner:
    """Bind one reviewed Publisher profile to its opaque persistent session."""

    __slots__ = ("_client", "_session_key")

    def __init__(self, client: BrowserClient, session_key: str) -> None:
        if not isinstance(client, BrowserClient):
            raise TypeError("client must be a BrowserClient")
        self._client = client
        self._session_key = BrowserSessionBroker.validate_session_key(str(session_key))

    def run(
        self,
        scope: AccessScope,
        request: BrowserRequest | str,
        policy: AccessPolicy,
        *,
        flow: Callable[[BrowserFlowSession], object] | None = None,
        destination_guard: BrowserDestinationGuard | None = None,
        capture_guard: BrowserCaptureGuard | None = None,
        navigation_only: bool = False,
        budget: BrowserBudget | None = None,
        timeout_seconds: float | None = None,
        cancel_event: threading.Event | None = None,
    ) -> BrowserResult:
        return self._client.run(
            scope,
            request,
            policy,
            flow=flow,
            destination_guard=destination_guard,
            capture_guard=capture_guard,
            navigation_only=navigation_only,
            session_key=self._session_key,
            budget=budget,
            timeout_seconds=timeout_seconds,
            cancel_event=cancel_event,
        )


def _has_generic_mapping(provider_name: str) -> bool:
    return any(
        mapping.capability is AcquisitionCapability.GENERIC_ASSET_HINT
        and mapping.production_available
        for mapping in _FIXED_MAPPINGS[provider_name]
    )


def _public_protocol_source(
    provider_name: str,
    configuration: Configuration,
    dependencies: AcquisitionAssemblyDependencies,
    locator_fetcher: PublicLocatorFetcher,
) -> PdfRouteAdapter:
    common = {
        "http_client": dependencies.http_client,
        "locator_fetcher": locator_fetcher,
        "cancel_event": dependencies.cancel_event,
    }
    if provider_name == ProviderName.ARXIV.value:
        return ArxivPdfSource(
            **common,
            access_scope=ARXIV_ACCESS_SCOPE,
            access_policy=ARXIV_ACCESS_POLICY,
        )
    if provider_name == ProviderName.EUROPE_PMC.value:
        return EuropePmcPdfSource(
            **common,
            access_scope=EUROPE_PMC_ACCESS_SCOPE,
            access_policy=EUROPE_PMC_ACCESS_POLICY,
        )
    if provider_name == ProviderName.UNPAYWALL.value:
        ordinary = configuration.sources.acquisition.unpaywall
        if ordinary is None:
            raise AcquisitionRegistryError("missing-ordinary-parameter", provider_name)
        return UnpaywallPdfSource(
            **common,
            access_scope=UNPAYWALL_ACCESS_SCOPE,
            access_policy=UNPAYWALL_ACCESS_POLICY,
            contact_email=ordinary.contact_email,
        )
    if provider_name == ProviderName.SCI_HUB.value:
        return ConfiguredSciHubPdfSource(
            resolver=dependencies.configured_sci_hub_resolver,
            locator_fetcher=locator_fetcher,
            cancel_event=dependencies.cancel_event,
        )
    raise AcquisitionRegistryError("source-assembly-unsupported", provider_name)


def _required_authorized_credential(
    credentials: CredentialLookup,
    provider_name: str,
    field_name: str,
) -> str:
    value = credentials.get(provider_name, field_name)
    if value is None:
        raise AcquisitionRegistryError(
            "acquisition-authorized-credential-missing",
            provider_name,
        )
    return value


def _authorized_client(
    provider_name: str,
    credentials: CredentialLookup,
    dependencies: AcquisitionAssemblyDependencies,
) -> AuthorizedProviderClient:
    try:
        if provider_name == ProviderName.CORE.value:
            return CoreAuthorizedPdfClient(
                http_client=dependencies.http_client,
                api_key=_required_authorized_credential(
                    credentials,
                    provider_name,
                    "api_key",
                ),
                cancel_event=dependencies.cancel_event,
            )
        if provider_name == ProviderName.ELSEVIER.value:
            return ElsevierAuthorizedPdfClient(
                http_client=dependencies.http_client,
                api_key=_required_authorized_credential(
                    credentials,
                    provider_name,
                    "api_key",
                ),
                institution_token=credentials.get(provider_name, "institution_token"),
                cancel_event=dependencies.cancel_event,
            )
        if provider_name == ProviderName.WILEY.value:
            return WileyAuthorizedPdfClient(
                http_client=dependencies.http_client,
                tdm_api_token=_required_authorized_credential(
                    credentials,
                    provider_name,
                    "tdm_api_token",
                ),
                cancel_event=dependencies.cancel_event,
            )
    except AcquisitionRegistryError:
        raise
    except (TypeError, ValueError):
        raise AcquisitionRegistryError(
            "acquisition-authorized-credential-invalid",
            provider_name,
        ) from None
    raise AcquisitionRegistryError("source-assembly-unsupported", provider_name)


def _authorized_source(
    provider_name: str,
    dependencies: AcquisitionAssemblyDependencies,
) -> AuthorizedPdfSource:
    contract = PRODUCTION_AUTHORIZED_PROVIDER_CATALOG.get(provider_name)
    credentials = dependencies.credentials
    present_fields = (
        frozenset() if credentials is None else frozenset(credentials.field_names(provider_name))
    )
    status = authorized_route_status(
        contract,
        product_ready=contract is not None,
        access_policy_ready=provider_name
        in {
            ProviderName.CORE.value,
            ProviderName.ELSEVIER.value,
            ProviderName.WILEY.value,
        },
        present_credential_fields=present_fields,
    )
    if status.readiness is not RouteReadiness.READY:
        failure = status.failure
        raise AcquisitionRegistryError(
            "authorized-readiness-failed" if failure is None else failure.code,
            provider_name,
        )
    if credentials is None or contract is None:
        raise AcquisitionRegistryError("source-assembly-unsupported", provider_name)
    client = _authorized_client(provider_name, credentials, dependencies)
    return AuthorizedPdfSource(
        contract=contract,
        client=client,
        provenance_id_factory=dependencies.provenance_id_factory,
        clock=dependencies.clock,
    )


def _validate_source(
    source: PdfRouteAdapter,
    provider_name: str,
    dependencies: AcquisitionAssemblyDependencies,
    locator_fetcher: PublicLocatorFetcher,
) -> None:
    if source.source_name != provider_name or source.acquisition_path is not AcquisitionPath.PUBLIC:
        raise AcquisitionRegistryError("source-contract-mismatch", provider_name)
    if provider_name == ProviderName.SCI_HUB.value:
        if getattr(source, "_locator_fetcher", None) is not locator_fetcher:
            raise AcquisitionRegistryError("network-bypass", provider_name)
        if getattr(source, "_cancel_event", None) is not dependencies.cancel_event:
            raise AcquisitionRegistryError("cancel-boundary-mismatch", provider_name)
        return
    if getattr(source, "_http_client", None) is not dependencies.http_client:
        raise AcquisitionRegistryError("network-bypass", provider_name)
    if getattr(source, "_locator_fetcher", None) is not locator_fetcher:
        raise AcquisitionRegistryError("network-bypass", provider_name)
    if getattr(source, "_cancel_event", None) is not dependencies.cancel_event:
        raise AcquisitionRegistryError("cancel-boundary-mismatch", provider_name)
    expected_access = {
        ProviderName.ARXIV.value: (ARXIV_ACCESS_SCOPE, ARXIV_ACCESS_POLICY),
        ProviderName.EUROPE_PMC.value: (
            EUROPE_PMC_ACCESS_SCOPE,
            EUROPE_PMC_ACCESS_POLICY,
        ),
        ProviderName.UNPAYWALL.value: (
            UNPAYWALL_ACCESS_SCOPE,
            UNPAYWALL_ACCESS_POLICY,
        ),
    }[provider_name]
    if (
        getattr(source, "_access_scope", None),
        getattr(source, "_access_policy", None),
    ) != expected_access:
        raise AcquisitionRegistryError("access-contract-mismatch", provider_name)


def _validate_dependencies(dependencies: AcquisitionAssemblyDependencies) -> None:
    if (
        getattr(dependencies.http_client, "_coordinator", None)
        is not dependencies.access_coordinator
    ):
        raise AcquisitionRegistryError("network-bypass")
    browser = dependencies.browser_client
    if browser is not None and (
        getattr(browser, "_coordinator", None) is not dependencies.access_coordinator
    ):
        raise AcquisitionRegistryError("network-bypass", "controlled-browser")
    if browser is not None and (
        getattr(browser, "_session_broker", None) is not dependencies.browser_session_broker
    ):
        raise AcquisitionRegistryError("network-bypass", "controlled-browser")


def _route_requirements(
    source_name: str,
) -> tuple[tuple[str, ...], tuple[str, ...], bool]:
    if source_name == ProviderName.ARXIV.value:
        return ("arxiv",), ("arxiv",), False
    if source_name == ProviderName.EUROPE_PMC.value:
        return ("pmcid",), ("europe-pmc",), False
    if source_name == ProviderName.UNPAYWALL.value:
        return ("doi",), (), False
    if source_name == ProviderName.SCI_HUB.value:
        return (), (), True
    if source_name == ProviderName.CORE.value:
        return (), ("core",), False
    if source_name == ProviderName.ELSEVIER.value:
        return ("doi", "pii", "elsevier-article-eid"), (), False
    if source_name == ProviderName.WILEY.value:
        return ("doi",), (), False
    return (), (), False


def _route_spec_for_source(source: PdfRouteAdapter) -> RouteSpec:
    source_name = getattr(source, "source_name", "direct")
    acquisition_path = getattr(source, "acquisition_path", None)
    if type(source_name) is not str or not isinstance(acquisition_path, AcquisitionPath):
        raise AcquisitionRegistryError("route-contract-mismatch")
    identifiers, providers, any_identifier = _route_requirements(source_name)
    profile_access_key = {
        ProviderName.CORE.value: "core-open-access",
        ProviderName.ELSEVIER.value: "elsevier-sciencedirect",
        ProviderName.WILEY.value: "wiley-online-library",
    }.get(source_name)
    if acquisition_path is AcquisitionPath.AUTHORIZED_PROVIDER_API:
        capability = (
            RouteCapability.MULTI_STEP_PDF_OBJECT
            if source_name == ProviderName.ELSEVIER.value
            else RouteCapability.DIRECT_PDF
        )
        quota_group = {
            ProviderName.CORE.value: "core-api",
            ProviderName.ELSEVIER.value: "elsevier-article-object",
            ProviderName.WILEY.value: "wiley-tdm",
        }.get(source_name)
    elif source_name == "direct":
        capability = RouteCapability.DIRECT_PDF
        quota_group = None
    else:
        capability = RouteCapability.PUBLIC_PROTOCOL
        quota_group = f"{source_name}-public"
    return RouteSpec(
        route_key=source.route_key,
        tier=acquisition_path,
        capability=capability,
        readiness=RouteReadiness.READY,
        profile_access_key=profile_access_key,
        quota_group=quota_group,
        required_identifier_namespaces=identifiers,
        required_provider_record_names=providers,
        requires_any_identifier=any_identifier,
    )


def _pending_route_spec(provider_name: str, *, authorized: bool) -> RouteSpec:
    identifiers, providers, any_identifier = _route_requirements(provider_name)
    if authorized:
        route_key = {
            "elsevier": "api:elsevier-article-object",
            "wiley": "api:wiley-tdm-v1",
        }.get(provider_name, f"api:{provider_name}")
        tier = AcquisitionPath.AUTHORIZED_PROVIDER_API
        capability = (
            RouteCapability.MULTI_STEP_PDF_OBJECT
            if provider_name == ProviderName.ELSEVIER.value
            else RouteCapability.DIRECT_PDF
        )
        profile_access_key = {
            "core": "core-open-access",
            "elsevier": "elsevier-sciencedirect",
            "wiley": "wiley-online-library",
        }.get(provider_name)
        quota_group = {
            "core": "core-api",
            "elsevier": "elsevier-article-object",
            "wiley": "wiley-tdm",
        }.get(provider_name)
    else:
        route_key = f"public:{provider_name}"
        tier = AcquisitionPath.PUBLIC
        capability = RouteCapability.PUBLIC_PROTOCOL
        profile_access_key = None
        quota_group = f"{provider_name}-public"
    return RouteSpec(
        route_key=route_key,
        tier=tier,
        capability=capability,
        readiness=RouteReadiness.UNCONFIGURED,
        profile_access_key=profile_access_key,
        quota_group=quota_group,
        required_identifier_namespaces=identifiers,
        required_provider_record_names=providers,
        requires_any_identifier=any_identifier,
    )


def _assemble_authorized_routes(
    selected: tuple[str, ...],
    dependencies: AcquisitionAssemblyDependencies,
    route_bindings: list[RouteAdapterBinding],
) -> None:
    expected_unready = {
        "acquisition-authorized-credential-missing",
        "acquisition-authorized-product-not-ready",
        "acquisition-authorized-access-policy-missing",
    }
    for provider_name in selected:
        if provider_name not in PRODUCTION_AUTHORIZED_PROVIDER_CATALOG:
            continue
        try:
            source = _authorized_source(provider_name, dependencies)
        except AcquisitionRegistryError as error:
            if error.code not in expected_unready:
                raise
            route_bindings.append(
                RouteAdapterBinding(
                    spec=_pending_route_spec(provider_name, authorized=True),
                    adapter=None,
                )
            )
            continue
        route_bindings.append(
            RouteAdapterBinding(spec=_route_spec_for_source(source), adapter=source)
        )


def _browser_rule_for_profile(profile: PublisherAccessProfile) -> BrowserSiteRule:
    matches = tuple(
        rule
        for rule in PRODUCTION_BROWSER_RULE_CATALOG.rules
        if rule.rule_id == profile.browser_rule_id
        and rule.revision == profile.browser_rule_revision
    )
    if len(matches) != 1:
        raise AcquisitionRegistryError("browser-profile-rule-mismatch")
    rule = matches[0]
    if (
        profile.browser_allowed_origins != rule.allowed_origins
        or profile.browser_rate_limit_group != rule.web_scope_provider_name
    ):
        raise AcquisitionRegistryError("browser-profile-rule-mismatch")
    return rule


def _browser_route_readiness(
    configuration: Configuration,
    dependencies: AcquisitionAssemblyDependencies,
) -> RouteReadiness:
    if CONTROLLED_BROWSER_PRODUCTION_STATUS.readiness is not RouteReadiness.READY:
        return RouteReadiness.UNSUPPORTED
    if not configuration.access.browser_enabled:
        return RouteReadiness.DISABLED
    if dependencies.browser_client is None:
        return RouteReadiness.UNCONFIGURED
    return RouteReadiness.READY


def _browser_route_spec(
    profile: PublisherAccessProfile,
    readiness: RouteReadiness,
) -> RouteSpec:
    route_key = profile.browser_route_key
    risk_group = profile.browser_rate_limit_group
    if route_key is None or risk_group is None:
        raise AcquisitionRegistryError("browser-profile-route-mismatch")
    return RouteSpec(
        route_key=route_key,
        tier=AcquisitionPath.CONTROLLED_BROWSER,
        capability=RouteCapability.BROWSER_PDF,
        readiness=readiness,
        profile_access_key=profile.access_key,
        risk_group=risk_group,
        required_identifier_namespaces=profile.stable_locator_namespaces,
    )


def _assemble_browser_routes(
    configuration: Configuration,
    dependencies: AcquisitionAssemblyDependencies,
    route_bindings: list[RouteAdapterBinding],
) -> None:
    readiness = _browser_route_readiness(configuration, dependencies)
    for profile in PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG:
        if profile.browser_route_key is None:
            continue
        rule = _browser_rule_for_profile(profile)
        adapter: ControlledBrowserPdfSource | None = None
        if readiness is RouteReadiness.READY:
            client = dependencies.browser_client
            session_key = profile.browser_session_key
            if client is None or session_key is None:
                raise AcquisitionRegistryError("browser-runtime-mismatch")
            adapter = ControlledBrowserPdfSource(
                runner=_SessionBoundBrowserRunner(client, session_key),
                route_key=profile.browser_route_key,
                rule_catalog=BrowserRuleCatalog((rule,)),
                web_access_profile_resolver=dependencies.web_access_profile_resolver,
                access_policy=AccessPolicy(max_concurrency=1),
                cancel_event=dependencies.cancel_event,
                provenance_id_factory=dependencies.provenance_id_factory,
                clock=dependencies.clock,
            )
        route_bindings.append(
            RouteAdapterBinding(
                spec=_browser_route_spec(profile, readiness),
                adapter=adapter,
            )
        )


def build_acquisition_registry(
    configuration: Configuration,
    dependencies: AcquisitionAssemblyDependencies,
) -> AcquisitionRegistry:
    """Assemble installed route capabilities without performing external I/O."""

    if not isinstance(dependencies, AcquisitionAssemblyDependencies):
        raise AcquisitionRegistryError("dependencies-invalid")
    _validate_dependencies(dependencies)
    statuses = acquisition_provider_statuses(
        configuration,
        configured_sci_hub_resolver=dependencies.configured_sci_hub_resolver,
    )
    status_by_name = {status.provider_name: status for status in statuses}
    selected = tuple(provider.value for provider in configuration.sources.acquisition.providers)

    locator_fetcher = PublicLocatorFetcher(
        http_client=dependencies.http_client,
        web_access_profile_resolver=dependencies.web_access_profile_resolver,
        cancel_event=dependencies.cancel_event,
        provenance_id_factory=dependencies.provenance_id_factory,
        clock=dependencies.clock,
    )
    route_bindings: list[RouteAdapterBinding] = []

    configured_landing_providers = tuple(
        provider_name for provider_name in selected if _has_generic_mapping(provider_name)
    )
    direct = DirectPdfSource(fetcher=locator_fetcher)
    direct_prefix = _OrderedDirectRoute(
        direct_source=direct,
        direct_slice=_DirectSlice.DIRECT_PREFIX,
    )
    route_bindings.append(
        RouteAdapterBinding(
            spec=_route_spec_for_source(direct_prefix),
            adapter=direct_prefix,
        )
    )

    independent_public = frozenset(
        {
            ProviderName.ARXIV.value,
            ProviderName.EUROPE_PMC.value,
            ProviderName.UNPAYWALL.value,
            ProviderName.SCI_HUB.value,
        }
    )
    for provider_name in selected:
        # After the global direct-file prefix, each configured Provider owns one
        # stable public-order slot.  Its independent protocol runs before its
        # ordinary landing hints; Providers without either simply add nothing.
        if provider_name in independent_public:
            status = status_by_name[provider_name]
            if status.ready:
                source = _public_protocol_source(
                    provider_name,
                    configuration,
                    dependencies,
                    locator_fetcher,
                )
                _validate_source(source, provider_name, dependencies, locator_fetcher)
                route_bindings.append(
                    RouteAdapterBinding(
                        spec=_route_spec_for_source(source),
                        adapter=source,
                    )
                )
            else:
                route_bindings.append(
                    RouteAdapterBinding(
                        spec=_pending_route_spec(provider_name, authorized=False),
                        adapter=None,
                    )
                )

        if provider_name not in configured_landing_providers:
            continue
        provider_landing = _OrderedDirectRoute(
            direct_source=direct,
            direct_slice=_DirectSlice.PROVIDER_LANDING,
            provider_name=provider_name,
        )
        route_bindings.append(
            RouteAdapterBinding(
                spec=_route_spec_for_source(provider_landing),
                adapter=provider_landing,
            )
        )

    # Metadata-only Providers and already-saved hints from a currently disabled
    # Provider remain valid evidence.  Their non-duplicate landing hints form a
    # deterministic fallback after every explicitly configured public slot.
    fallback_landing = _OrderedDirectRoute(
        direct_source=direct,
        direct_slice=_DirectSlice.FALLBACK_LANDING,
        excluded_provider_names=configured_landing_providers,
    )
    route_bindings.append(
        RouteAdapterBinding(
            spec=_route_spec_for_source(fallback_landing),
            adapter=fallback_landing,
        )
    )

    _assemble_authorized_routes(
        selected,
        dependencies,
        route_bindings,
    )
    _assemble_browser_routes(
        configuration,
        dependencies,
        route_bindings,
    )

    stage_order = {
        AcquisitionPath.PUBLIC: 0,
        AcquisitionPath.AUTHORIZED_PROVIDER_API: 1,
        AcquisitionPath.CONTROLLED_BROWSER: 2,
    }
    if tuple(stage_order[item.spec.tier] for item in route_bindings) != tuple(
        sorted(stage_order[item.spec.tier] for item in route_bindings)
    ):
        raise AcquisitionRegistryError("production-stage-mismatch")
    doi_landing_resolver = DoiLandingResolver(
        http_client=dependencies.http_client,
        web_access_profile_resolver=dependencies.web_access_profile_resolver,
        cancel_event=dependencies.cancel_event,
    )
    route_registry = AcquisitionRouteRegistry(
        profile_catalog=PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG,
        bindings=tuple(route_bindings),
    )
    planner = ProgressiveAcquisitionPlanner(
        resolver=PublisherAccessResolver(PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG),
        builder=AcquisitionPlanBuilder(PRODUCTION_PUBLISHER_ACCESS_PROFILE_CATALOG),
        route_specs=route_registry.route_specs,
        doi_landing_resolver=doi_landing_resolver,
    )
    return AcquisitionRegistry(
        statuses=statuses,
        route_registry=route_registry,
        planner=planner,
    )


__all__ = (
    "ACQUISITION_PROVIDER_ORDER",
    "PRODUCTION_WEB_HOSTS_BY_PROVIDER",
    "AcquisitionAssemblyDependencies",
    "AcquisitionCapability",
    "AcquisitionProviderMapping",
    "AcquisitionProviderStatus",
    "AcquisitionRegistry",
    "AcquisitionRegistryError",
    "acquisition_provider_statuses",
    "build_acquisition_registry",
    "production_web_access_profile_resolver",
    "validate_acquisition_provider_matrix",
)
