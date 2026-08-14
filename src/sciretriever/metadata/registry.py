"""Static Metadata capability registry and pre-call readiness assembly.

The registry is deliberately closed over the accepted pre-v1 provider matrix.
It does not discover plugins, infer capabilities from method names, read
configuration or credentials files, or probe the network.  The root
configuration boundary supplies one already-loaded private credential bundle;
Block 7's Bootstrap will supply the shared Network objects and own the wider
production object graph.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Callable, Final, Mapping, TypedDict, cast

from sciretriever.configuration import CredentialLookup, credential_status_for
from sciretriever.metadata.ports import (
    MetadataLookupPort,
    ReferenceQueryPort,
    TopicSearchPort,
)
from sciretriever.metadata.probe import (
    MetadataProbeEvidence,
    MetadataProbeFailure,
    MetadataProbePort,
)
from sciretriever.metadata.providers.arxiv import (
    ACCESS_SCOPE as ARXIV_ACCESS_SCOPE,
)
from sciretriever.metadata.providers.arxiv import (
    BASELINE_ACCESS_POLICY as ARXIV_ACCESS_POLICY,
)
from sciretriever.metadata.providers.arxiv import (
    ArxivAdapter,
)
from sciretriever.metadata.providers.core import (
    ACCESS_SCOPE as CORE_ACCESS_SCOPE,
)
from sciretriever.metadata.providers.core import (
    BASELINE_ACCESS_POLICY as CORE_ACCESS_POLICY,
)
from sciretriever.metadata.providers.core import (
    CoreAdapter,
)
from sciretriever.metadata.providers.crossref import (
    POLITE_ACCESS_SCOPE as CROSSREF_POLITE_ACCESS_SCOPE,
)
from sciretriever.metadata.providers.crossref import (
    POLITE_BASELINE_ACCESS_POLICY as CROSSREF_POLITE_ACCESS_POLICY,
)
from sciretriever.metadata.providers.crossref import (
    PUBLIC_ACCESS_SCOPE as CROSSREF_PUBLIC_ACCESS_SCOPE,
)
from sciretriever.metadata.providers.crossref import (
    PUBLIC_BASELINE_ACCESS_POLICY as CROSSREF_PUBLIC_ACCESS_POLICY,
)
from sciretriever.metadata.providers.crossref import (
    CrossrefAdapter,
)
from sciretriever.metadata.providers.datacite import (
    ACCESS_SCOPE as DATACITE_ACCESS_SCOPE,
)
from sciretriever.metadata.providers.datacite import (
    BASELINE_ACCESS_POLICY as DATACITE_ACCESS_POLICY,
)
from sciretriever.metadata.providers.datacite import (
    DataCiteAdapter,
)
from sciretriever.metadata.providers.elsevier import (
    SEARCH_ACCESS_SCOPE as ELSEVIER_SEARCH_ACCESS_SCOPE,
)
from sciretriever.metadata.providers.elsevier import (
    SEARCH_BASELINE_ACCESS_POLICY as ELSEVIER_SEARCH_ACCESS_POLICY,
)
from sciretriever.metadata.providers.elsevier import (
    ElsevierScopusAdapter,
)
from sciretriever.metadata.providers.europe_pmc import (
    ACCESS_SCOPE as EUROPE_PMC_ACCESS_SCOPE,
)
from sciretriever.metadata.providers.europe_pmc import (
    BASELINE_ACCESS_POLICY as EUROPE_PMC_ACCESS_POLICY,
)
from sciretriever.metadata.providers.europe_pmc import (
    EuropePmcAdapter,
)
from sciretriever.metadata.providers.openalex import (
    ACCESS_SCOPE as OPENALEX_ACCESS_SCOPE,
)
from sciretriever.metadata.providers.openalex import (
    BASELINE_ACCESS_POLICY as OPENALEX_ACCESS_POLICY,
)
from sciretriever.metadata.providers.openalex import (
    OpenAlexAdapter,
)
from sciretriever.metadata.providers.opencitations import (
    ACCESS_SCOPE as OPENCITATIONS_ACCESS_SCOPE,
)
from sciretriever.metadata.providers.opencitations import (
    BASELINE_ACCESS_POLICY as OPENCITATIONS_ACCESS_POLICY,
)
from sciretriever.metadata.providers.opencitations import (
    OpenCitationsAdapter,
)
from sciretriever.metadata.providers.semantic_scholar import (
    ACCESS_SCOPE as SEMANTIC_SCHOLAR_ACCESS_SCOPE,
)
from sciretriever.metadata.providers.semantic_scholar import (
    BASELINE_ACCESS_POLICY as SEMANTIC_SCHOLAR_ACCESS_POLICY,
)
from sciretriever.metadata.providers.semantic_scholar import (
    SemanticScholarAdapter,
)
from sciretriever.metadata.providers.springer import (
    ACCESS_SCOPE as SPRINGER_ACCESS_SCOPE,
)
from sciretriever.metadata.providers.springer import (
    BASELINE_ACCESS_POLICY as SPRINGER_ACCESS_POLICY,
)
from sciretriever.metadata.providers.springer import (
    SpringerMetaV2Adapter,
)
from sciretriever.metadata.providers.web_of_science import (
    EXPANDED_ACCESS_SCOPE as WOS_EXPANDED_ACCESS_SCOPE,
)
from sciretriever.metadata.providers.web_of_science import (
    EXPANDED_BASELINE_ACCESS_POLICY as WOS_EXPANDED_ACCESS_POLICY,
)
from sciretriever.metadata.providers.web_of_science import (
    STARTER_ACCESS_SCOPE as WOS_STARTER_ACCESS_SCOPE,
)
from sciretriever.metadata.providers.web_of_science import (
    STARTER_BASELINE_ACCESS_POLICY as WOS_STARTER_ACCESS_POLICY,
)
from sciretriever.metadata.providers.web_of_science import (
    WebOfScienceExpandedAdapter,
    WebOfScienceStarterAdapter,
)
from sciretriever.model.configuration import (
    Configuration,
    ConfigurationProbeResult,
    CredentialStatus,
    CrossrefAccessMode,
    ProbeOutcome,
    ProviderCapability,
    ProviderName,
    WebOfScienceProduct,
)
from sciretriever.model.discovery import ProviderDiscoveryLimit
from sciretriever.model.primitives import ObservationId, ProvenanceId, UtcTimestamp
from sciretriever.network.admission import AccessCoordinator, AccessPolicy, AccessScope
from sciretriever.network.http import HttpClient


class MetadataCapability(str, Enum):
    """The three independently registered Metadata provider ports."""

    TOPIC_SEARCH = "topic-search"
    LOOKUP = "lookup"
    REFERENCE_QUERY = "reference-query"


_SEARCH_LOOKUP: Final[tuple[MetadataCapability, ...]] = (
    MetadataCapability.TOPIC_SEARCH,
    MetadataCapability.LOOKUP,
)
_SEARCH_LOOKUP_REFERENCE: Final[tuple[MetadataCapability, ...]] = (
    MetadataCapability.TOPIC_SEARCH,
    MetadataCapability.LOOKUP,
    MetadataCapability.REFERENCE_QUERY,
)
_LOOKUP_REFERENCE: Final[tuple[MetadataCapability, ...]] = (
    MetadataCapability.LOOKUP,
    MetadataCapability.REFERENCE_QUERY,
)

METADATA_PROVIDER_ORDER: Final[tuple[str, ...]] = (
    "web-of-science",
    "crossref",
    "semantic-scholar",
    "arxiv",
    "openalex",
    "europe-pmc",
    "elsevier",
    "springer",
    "datacite",
    "core",
    "opencitations",
)
METADATA_SEARCH_PROVIDER_ORDER: Final[tuple[str, ...]] = METADATA_PROVIDER_ORDER[:-1]

_FIXED_CAPABILITIES: Final[dict[str, tuple[MetadataCapability, ...]]] = {
    "crossref": _SEARCH_LOOKUP,
    "semantic-scholar": _SEARCH_LOOKUP_REFERENCE,
    "arxiv": _SEARCH_LOOKUP,
    "openalex": _SEARCH_LOOKUP_REFERENCE,
    "europe-pmc": _SEARCH_LOOKUP_REFERENCE,
    "elsevier": _SEARCH_LOOKUP,
    "springer": _SEARCH_LOOKUP,
    "datacite": _SEARCH_LOOKUP_REFERENCE,
    "core": _SEARCH_LOOKUP_REFERENCE,
    "opencitations": _LOOKUP_REFERENCE,
}

_FIXED_IMPLEMENTATIONS: Final[dict[str, type[object]]] = {
    "crossref": CrossrefAdapter,
    "semantic-scholar": SemanticScholarAdapter,
    "arxiv": ArxivAdapter,
    "openalex": OpenAlexAdapter,
    "europe-pmc": EuropePmcAdapter,
    "elsevier": ElsevierScopusAdapter,
    "springer": SpringerMetaV2Adapter,
    "datacite": DataCiteAdapter,
    "core": CoreAdapter,
    "opencitations": OpenCitationsAdapter,
}

_FIXED_ACCESS: Final[dict[str, tuple[AccessScope, AccessPolicy]]] = {
    "semantic-scholar": (SEMANTIC_SCHOLAR_ACCESS_SCOPE, SEMANTIC_SCHOLAR_ACCESS_POLICY),
    "arxiv": (ARXIV_ACCESS_SCOPE, ARXIV_ACCESS_POLICY),
    "openalex": (OPENALEX_ACCESS_SCOPE, OPENALEX_ACCESS_POLICY),
    "europe-pmc": (EUROPE_PMC_ACCESS_SCOPE, EUROPE_PMC_ACCESS_POLICY),
    "elsevier": (
        ELSEVIER_SEARCH_ACCESS_SCOPE,
        ELSEVIER_SEARCH_ACCESS_POLICY,
    ),
    "springer": (SPRINGER_ACCESS_SCOPE, SPRINGER_ACCESS_POLICY),
    "datacite": (DATACITE_ACCESS_SCOPE, DATACITE_ACCESS_POLICY),
    "core": (CORE_ACCESS_SCOPE, CORE_ACCESS_POLICY),
    "opencitations": (OPENCITATIONS_ACCESS_SCOPE, OPENCITATIONS_ACCESS_POLICY),
}

_READY_CREDENTIAL_STATUSES: Final[frozenset[CredentialStatus]] = frozenset(
    {
        CredentialStatus.NOT_REQUIRED,
        CredentialStatus.CONFIGURED,
        CredentialStatus.OPTIONAL_MISSING,
    }
)


class MetadataRegistryError(RuntimeError):
    """A stable, secret-free failure raised before any Provider call."""

    __slots__ = ("code", "provider_name")

    def __init__(self, code: str, provider_name: str = "metadata") -> None:
        self.code = code
        self.provider_name = provider_name
        super().__init__(f"metadata registry error [{provider_name}:{code}]")

    def __repr__(self) -> str:
        return f"MetadataRegistryError(code={self.code!r}, provider_name={self.provider_name!r})"


@dataclass(frozen=True, slots=True)
class MetadataAssemblyDependencies:
    """Shared process-local dependencies supplied by the later Bootstrap."""

    http_client: HttpClient = field(repr=False)
    access_coordinator: AccessCoordinator = field(repr=False)
    observation_id_factory: Callable[[], ObservationId] = field(repr=False)
    provenance_id_factory: Callable[[], ProvenanceId] = field(repr=False)
    clock: Callable[[], UtcTimestamp] = field(repr=False)

    def __post_init__(self) -> None:
        if not isinstance(self.http_client, HttpClient):
            raise TypeError("http_client must be an HttpClient")
        if not isinstance(self.access_coordinator, AccessCoordinator):
            raise TypeError("access_coordinator must be an AccessCoordinator")
        for value in (
            self.observation_id_factory,
            self.provenance_id_factory,
            self.clock,
        ):
            if not callable(value):
                raise TypeError("metadata assembly factories must be callable")


class _CommonArguments(TypedDict):
    http_client: HttpClient
    access_coordinator: AccessCoordinator
    access_scope: AccessScope
    access_policy: AccessPolicy
    observation_id_factory: Callable[[], ObservationId]
    provenance_id_factory: Callable[[], ProvenanceId]
    clock: Callable[[], UtcTimestamp]


@dataclass(frozen=True, slots=True)
class MetadataProviderStatus:
    """One local, static and secret-free capability/readiness entry."""

    provider_name: str
    production_implementation: type[object] | None
    capabilities: tuple[MetadataCapability, ...]
    enabled: bool
    ready: bool
    failure_code: str | None
    access_scope: AccessScope | None
    access_policy: AccessPolicy | None
    production_available: bool = True
    uses_shared_network: bool = True
    uses_private_limiter: bool = False

    def __repr__(self) -> str:
        implementation = self.production_implementation
        implementation_name = None if implementation is None else implementation.__name__
        capabilities = tuple(capability.value for capability in self.capabilities)
        return (
            "MetadataProviderStatus("
            f"provider_name={self.provider_name!r}, "
            f"production_implementation={implementation_name!r}, "
            f"capabilities={capabilities!r}, enabled={self.enabled!r}, "
            f"ready={self.ready!r}, failure_code={self.failure_code!r})"
        )


@dataclass(frozen=True, slots=True)
class MetadataProviderRegistration:
    """An enabled and ready production adapter registration."""

    provider_name: str
    adapter: object = field(repr=False)
    capabilities: tuple[MetadataCapability, ...]
    scan_limit: int | None


@dataclass(frozen=True, slots=True)
class MetadataRegistry:
    """Deterministic capability tuples ready for Metadata service assembly."""

    statuses: tuple[MetadataProviderStatus, ...]
    registrations: tuple[MetadataProviderRegistration, ...]
    topic_search_ports: tuple[TopicSearchPort, ...] = field(repr=False)
    lookup_ports: tuple[MetadataLookupPort, ...] = field(repr=False)
    reference_query_ports: tuple[ReferenceQueryPort, ...] = field(repr=False)
    topic_limits: tuple[ProviderDiscoveryLimit, ...]
    citation_limits: tuple[ProviderDiscoveryLimit, ...]

    def __repr__(self) -> str:
        providers = tuple(item.provider_name for item in self.registrations)
        search = tuple(item.provider_name for item in self.topic_limits)
        citations = tuple(item.provider_name for item in self.citation_limits)
        return (
            "MetadataRegistry("
            f"providers={providers!r}, topic_search={search!r}, "
            f"citation_query={citations!r})"
        )


@dataclass(frozen=True, slots=True)
class MetadataProbeRegistration:
    """One ready production Metadata adapter exposed to ``config test``."""

    provider: ProviderName
    adapter: MetadataProbePort = field(repr=False)
    capability: ProviderCapability = ProviderCapability.METADATA

    def __post_init__(self) -> None:
        if not isinstance(self.provider, ProviderName):
            raise MetadataRegistryError("probe-provider-invalid")
        if self.capability is not ProviderCapability.METADATA:
            raise MetadataRegistryError("probe-capability-invalid", self.provider.value)
        _validate_probe_adapter(self.adapter, self.provider)


@dataclass(frozen=True, slots=True)
class MetadataProbeRegistry:
    """Deterministic, non-persistent Metadata ``ConfigurationProbePort``.

    Building this value constructs the same production adapters used by normal
    Metadata operations, but never calls them.  A named configuration test may
    therefore use a ready adapter even when that Provider is not enabled for
    normal discovery; ``run_configuration_probes`` owns the enabled filtering
    for ``--all``.
    """

    registrations: tuple[MetadataProbeRegistration, ...]
    http_client: HttpClient = field(repr=False)
    access_coordinator: AccessCoordinator = field(repr=False)
    _by_key: Mapping[
        tuple[ProviderName, ProviderCapability],
        MetadataProbePort,
    ] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        if not isinstance(self.http_client, HttpClient):
            raise MetadataRegistryError("probe-network-invalid")
        if not isinstance(self.access_coordinator, AccessCoordinator):
            raise MetadataRegistryError("probe-network-invalid")
        if getattr(self.http_client, "_coordinator", None) is not self.access_coordinator:
            raise MetadataRegistryError("network-bypass")
        if not isinstance(self.registrations, tuple):
            raise MetadataRegistryError("probe-registrations-invalid")

        by_key: dict[tuple[ProviderName, ProviderCapability], MetadataProbePort] = {}
        observed_order: list[str] = []
        for registration in self.registrations:
            if not isinstance(registration, MetadataProbeRegistration):
                raise MetadataRegistryError("probe-registration-invalid")
            key = (registration.provider, registration.capability)
            if key in by_key:
                raise MetadataRegistryError(
                    "duplicate-probe-registration",
                    registration.provider.value,
                )
            _validate_probe_adapter(
                registration.adapter,
                registration.provider,
                http_client=self.http_client,
                access_coordinator=self.access_coordinator,
            )
            by_key[key] = registration.adapter
            observed_order.append(registration.provider.value)

        expected_order = tuple(
            provider for provider in METADATA_PROVIDER_ORDER if provider in observed_order
        )
        if tuple(observed_order) != expected_order:
            raise MetadataRegistryError("probe-provider-order-mismatch")
        object.__setattr__(self, "_by_key", MappingProxyType(by_key))

    @property
    def supported_capabilities(
        self,
    ) -> frozenset[tuple[ProviderName, ProviderCapability]]:
        # Support describes the closed production implementation matrix, not
        # current local readiness.  This distinction lets configuration status
        # report a missing ordinary parameter or credential as ``skipped``;
        # only locally ready entries are present in ``registrations`` and can
        # actually execute.
        return frozenset(
            (ProviderName(provider), ProviderCapability.METADATA)
            for provider in METADATA_PROVIDER_ORDER
        )

    def probe(
        self,
        provider: ProviderName,
        capability: ProviderCapability,
    ) -> ConfigurationProbeResult:
        """Run exactly one registered adapter-owned minimal Metadata probe."""

        if not isinstance(provider, ProviderName) or not isinstance(
            capability,
            ProviderCapability,
        ):
            raise TypeError("probe key must use ProviderName and ProviderCapability")
        adapter = self._by_key.get((provider, capability))
        if adapter is None:
            return _failed_probe_result(
                provider,
                capability,
                code="metadata-probe-unavailable",
                checks=(None, None, None, None),
            )
        try:
            evidence = adapter.probe_metadata()
        except MetadataProbeFailure as failure:
            return _failed_probe_result(
                provider,
                capability,
                code=failure.code,
                checks=(
                    failure.network_reachable,
                    failure.authentication_accepted,
                    failure.api_product_usable,
                    failure.minimal_response_parseable,
                ),
            )
        except Exception:
            return _failed_probe_result(
                provider,
                capability,
                code="metadata-probe-failed",
                checks=(None, None, None, None),
            )
        if not isinstance(evidence, MetadataProbeEvidence) or (
            evidence.provider_name != provider.value
        ):
            return _failed_probe_result(
                provider,
                capability,
                code="metadata-probe-invalid-result",
                checks=(None, None, None, None),
            )
        return ConfigurationProbeResult(
            provider=provider,
            capability=capability,
            outcome=ProbeOutcome.PASSED,
            local_ready=True,
            network_reachable=evidence.network_reachable,
            authentication_accepted=evidence.authentication_accepted,
            api_product_usable=evidence.api_product_usable,
            minimal_response_parseable=evidence.minimal_response_parseable,
        )

    def __repr__(self) -> str:
        providers = tuple(registration.provider.value for registration in self.registrations)
        return f"MetadataProbeRegistry(providers={providers!r})"


def _status_failure(
    *,
    provider_name: str,
    implementation: type[object] | None,
    capabilities: tuple[MetadataCapability, ...],
    enabled: bool,
    code: str,
    access_scope: AccessScope | None,
    access_policy: AccessPolicy | None,
) -> MetadataProviderStatus:
    return MetadataProviderStatus(
        provider_name=provider_name,
        production_implementation=implementation,
        capabilities=capabilities,
        enabled=enabled,
        ready=False,
        failure_code=code,
        access_scope=access_scope,
        access_policy=access_policy,
    )


def _credential_readiness(
    provider_name: str,
    credentials: CredentialLookup,
) -> tuple[bool, str | None]:
    status = credential_status_for(
        provider_name,
        ProviderCapability.METADATA,
        credentials=credentials,
        supported_capabilities=(ProviderCapability.METADATA,),
    ).status
    if status in _READY_CREDENTIAL_STATUSES:
        return True, None
    if status is CredentialStatus.UNSUPPORTED:
        return False, "missing-production-adapter"
    return False, "missing-required-credential"


def _web_of_science_status(
    configuration: Configuration,
    credentials: CredentialLookup,
    *,
    enabled: bool,
) -> MetadataProviderStatus:
    ordinary = configuration.sources.metadata.web_of_science
    if ordinary is None:
        return _status_failure(
            provider_name=ProviderName.WEB_OF_SCIENCE.value,
            implementation=None,
            capabilities=_SEARCH_LOOKUP,
            enabled=enabled,
            code="missing-ordinary-parameter",
            access_scope=None,
            access_policy=None,
        )
    if ordinary.product is WebOfScienceProduct.STARTER:
        implementation: type[object] = WebOfScienceStarterAdapter
        capabilities = _SEARCH_LOOKUP
        access_scope = WOS_STARTER_ACCESS_SCOPE
        access_policy = WOS_STARTER_ACCESS_POLICY
    else:
        implementation = WebOfScienceExpandedAdapter
        capabilities = _SEARCH_LOOKUP_REFERENCE
        access_scope = WOS_EXPANDED_ACCESS_SCOPE
        access_policy = WOS_EXPANDED_ACCESS_POLICY
    ready, failure_code = _credential_readiness(
        ProviderName.WEB_OF_SCIENCE.value,
        credentials,
    )
    return MetadataProviderStatus(
        provider_name=ProviderName.WEB_OF_SCIENCE.value,
        production_implementation=implementation,
        capabilities=capabilities,
        enabled=enabled,
        ready=ready,
        failure_code=failure_code,
        access_scope=access_scope,
        access_policy=access_policy,
    )


def _crossref_status(
    configuration: Configuration,
    credentials: CredentialLookup,
    *,
    enabled: bool,
) -> MetadataProviderStatus:
    ordinary = configuration.sources.metadata.crossref
    if ordinary is None:
        return _status_failure(
            provider_name=ProviderName.CROSSREF.value,
            implementation=CrossrefAdapter,
            capabilities=_SEARCH_LOOKUP,
            enabled=enabled,
            code="missing-ordinary-parameter",
            access_scope=None,
            access_policy=None,
        )
    if ordinary.mode is CrossrefAccessMode.POLITE:
        access_scope = CROSSREF_POLITE_ACCESS_SCOPE
        access_policy = CROSSREF_POLITE_ACCESS_POLICY
    else:
        access_scope = CROSSREF_PUBLIC_ACCESS_SCOPE
        access_policy = CROSSREF_PUBLIC_ACCESS_POLICY
    ready, failure_code = _credential_readiness(ProviderName.CROSSREF.value, credentials)
    return MetadataProviderStatus(
        provider_name=ProviderName.CROSSREF.value,
        production_implementation=CrossrefAdapter,
        capabilities=_SEARCH_LOOKUP,
        enabled=enabled,
        ready=ready,
        failure_code=failure_code,
        access_scope=access_scope,
        access_policy=access_policy,
    )


def _fixed_status(
    provider_name: str,
    credentials: CredentialLookup,
    *,
    enabled: bool,
) -> MetadataProviderStatus:
    implementation = _FIXED_IMPLEMENTATIONS[provider_name]
    capabilities = _FIXED_CAPABILITIES[provider_name]
    access_scope, access_policy = _FIXED_ACCESS[provider_name]
    ready, failure_code = _credential_readiness(provider_name, credentials)
    return MetadataProviderStatus(
        provider_name=provider_name,
        production_implementation=implementation,
        capabilities=capabilities,
        enabled=enabled,
        ready=ready,
        failure_code=failure_code,
        access_scope=access_scope,
        access_policy=access_policy,
    )


def metadata_provider_statuses(
    configuration: Configuration,
    credentials: CredentialLookup,
) -> tuple[MetadataProviderStatus, ...]:
    """Compute local static readiness without constructing clients or probing."""

    if not isinstance(configuration, Configuration):
        raise MetadataRegistryError("configuration-invalid")
    if not isinstance(credentials, CredentialLookup):
        raise MetadataRegistryError("credentials-invalid")
    enabled = frozenset(item.value for item in configuration.sources.metadata.providers)
    statuses: list[MetadataProviderStatus] = []
    for provider_name in METADATA_PROVIDER_ORDER:
        is_enabled = provider_name in enabled
        if provider_name == ProviderName.WEB_OF_SCIENCE.value:
            status = _web_of_science_status(
                configuration,
                credentials,
                enabled=is_enabled,
            )
        elif provider_name == ProviderName.CROSSREF.value:
            status = _crossref_status(
                configuration,
                credentials,
                enabled=is_enabled,
            )
        else:
            status = _fixed_status(provider_name, credentials, enabled=is_enabled)
        statuses.append(status)
    result = tuple(statuses)
    validate_metadata_provider_matrix(result)
    return result


def _expected_capabilities(status: MetadataProviderStatus) -> tuple[MetadataCapability, ...]:
    if status.provider_name != ProviderName.WEB_OF_SCIENCE.value:
        return _FIXED_CAPABILITIES[status.provider_name]
    if status.production_implementation is WebOfScienceExpandedAdapter:
        return _SEARCH_LOOKUP_REFERENCE
    return _SEARCH_LOOKUP


def _validate_implementation(status: MetadataProviderStatus) -> None:
    implementation = status.production_implementation
    if not status.production_available:
        if (
            implementation is not None
            or status.ready
            or status.failure_code != "missing-production-adapter"
        ):
            raise MetadataRegistryError("production-state-invalid", status.provider_name)
        return
    if status.provider_name == ProviderName.WEB_OF_SCIENCE.value:
        if implementation is None:
            if status.failure_code != "missing-ordinary-parameter" or status.ready:
                raise MetadataRegistryError("missing-production-adapter", status.provider_name)
            return
        if implementation not in (WebOfScienceStarterAdapter, WebOfScienceExpandedAdapter):
            raise MetadataRegistryError("implementation-mismatch", status.provider_name)
        return
    expected = _FIXED_IMPLEMENTATIONS[status.provider_name]
    if implementation is not expected:
        raise MetadataRegistryError("implementation-mismatch", status.provider_name)


def _validate_access(status: MetadataProviderStatus) -> None:
    if status.failure_code == "missing-ordinary-parameter":
        if status.provider_name in {
            ProviderName.WEB_OF_SCIENCE.value,
            ProviderName.CROSSREF.value,
        }:
            return
    if status.access_scope is None:
        raise MetadataRegistryError("missing-access-scope", status.provider_name)
    if status.access_policy is None:
        raise MetadataRegistryError("missing-access-policy", status.provider_name)
    if status.provider_name == ProviderName.WEB_OF_SCIENCE.value:
        expected = (
            (WOS_STARTER_ACCESS_SCOPE, WOS_STARTER_ACCESS_POLICY)
            if status.production_implementation is WebOfScienceStarterAdapter
            else (WOS_EXPANDED_ACCESS_SCOPE, WOS_EXPANDED_ACCESS_POLICY)
        )
    elif status.provider_name == ProviderName.CROSSREF.value:
        public = (CROSSREF_PUBLIC_ACCESS_SCOPE, CROSSREF_PUBLIC_ACCESS_POLICY)
        polite = (CROSSREF_POLITE_ACCESS_SCOPE, CROSSREF_POLITE_ACCESS_POLICY)
        if (status.access_scope, status.access_policy) not in (public, polite):
            raise MetadataRegistryError("access-contract-mismatch", status.provider_name)
        return
    else:
        expected = _FIXED_ACCESS[status.provider_name]
    if (status.access_scope, status.access_policy) != expected:
        raise MetadataRegistryError("access-contract-mismatch", status.provider_name)


def _validated_matrix_names(
    statuses: tuple[MetadataProviderStatus, ...],
) -> tuple[str, ...]:
    if not isinstance(statuses, tuple) or any(
        not isinstance(status, MetadataProviderStatus) for status in statuses
    ):
        raise MetadataRegistryError("matrix-invalid")
    names = tuple(status.provider_name for status in statuses)
    seen: set[str] = set()
    for name in names:
        if name not in METADATA_PROVIDER_ORDER:
            raise MetadataRegistryError("unknown-provider", name)
        if name in seen:
            raise MetadataRegistryError("duplicate-provider", name)
        seen.add(name)
    if set(names) != set(METADATA_PROVIDER_ORDER):
        raise MetadataRegistryError("missing-provider")
    if names != METADATA_PROVIDER_ORDER:
        raise MetadataRegistryError("provider-order-mismatch")
    return names


def _validate_provider_status(status: MetadataProviderStatus) -> None:
    if not status.uses_shared_network:
        raise MetadataRegistryError("network-bypass", status.provider_name)
    if status.uses_private_limiter:
        raise MetadataRegistryError("private-limiter-forbidden", status.provider_name)
    _validate_implementation(status)
    if status.capabilities != _expected_capabilities(status):
        raise MetadataRegistryError("capability-mismatch", status.provider_name)
    _validate_access(status)
    if status.ready != (status.failure_code is None):
        raise MetadataRegistryError("readiness-state-invalid", status.provider_name)


def validate_metadata_provider_matrix(
    statuses: tuple[MetadataProviderStatus, ...],
) -> None:
    """Validate an explicit matrix; capabilities are never inferred from objects."""

    _validated_matrix_names(statuses)
    for status in statuses:
        _validate_provider_status(status)


def _common_arguments(
    dependencies: MetadataAssemblyDependencies,
    status: MetadataProviderStatus,
) -> _CommonArguments:
    if status.access_scope is None:
        raise MetadataRegistryError("missing-access-scope", status.provider_name)
    if status.access_policy is None:
        raise MetadataRegistryError("missing-access-policy", status.provider_name)
    return {
        "http_client": dependencies.http_client,
        "access_coordinator": dependencies.access_coordinator,
        "access_scope": status.access_scope,
        "access_policy": status.access_policy,
        "observation_id_factory": dependencies.observation_id_factory,
        "provenance_id_factory": dependencies.provenance_id_factory,
        "clock": dependencies.clock,
    }


def _build_fixed_adapter(
    provider_name: str,
    credentials: CredentialLookup,
    common: _CommonArguments,
) -> object:
    if provider_name == ProviderName.SEMANTIC_SCHOLAR.value:
        return SemanticScholarAdapter(
            **common,
            api_key=credentials.get(provider_name, "api_key"),
        )
    if provider_name == ProviderName.ARXIV.value:
        return ArxivAdapter(**common)
    if provider_name == ProviderName.OPENALEX.value:
        return OpenAlexAdapter(
            **common,
            api_key=credentials.get(provider_name, "api_key"),
        )
    if provider_name == ProviderName.EUROPE_PMC.value:
        return EuropePmcAdapter(**common)
    if provider_name == ProviderName.ELSEVIER.value:
        return ElsevierScopusAdapter(
            **common,
            api_key=credentials.get(provider_name, "api_key"),
            institution_token=credentials.get(provider_name, "institution_token"),
        )
    if provider_name == ProviderName.SPRINGER.value:
        return SpringerMetaV2Adapter(
            **common,
            api_key=credentials.get(provider_name, "api_key"),
        )
    if provider_name == ProviderName.DATACITE.value:
        return DataCiteAdapter(**common)
    if provider_name == ProviderName.CORE.value:
        return CoreAdapter(
            **common,
            api_key=credentials.get(provider_name, "api_key"),
        )
    if provider_name == ProviderName.OPENCITATIONS.value:
        return OpenCitationsAdapter(
            **common,
            token=credentials.get(provider_name, "access_token"),
        )
    raise MetadataRegistryError("unknown-provider", provider_name)


def _build_adapter(
    configuration: Configuration,
    credentials: CredentialLookup,
    dependencies: MetadataAssemblyDependencies,
    status: MetadataProviderStatus,
) -> object:
    common = _common_arguments(dependencies, status)
    provider_name = status.provider_name
    if provider_name == ProviderName.WEB_OF_SCIENCE.value:
        ordinary = configuration.sources.metadata.web_of_science
        implementation = status.production_implementation
        if ordinary is None or implementation is None:
            raise MetadataRegistryError("missing-ordinary-parameter", provider_name)
        if implementation is WebOfScienceStarterAdapter:
            return WebOfScienceStarterAdapter(
                **common,
                api_key=credentials.get(provider_name, "api_key"),
                database=ordinary.database,
                edition=ordinary.edition,
            )
        if implementation is WebOfScienceExpandedAdapter:
            return WebOfScienceExpandedAdapter(
                **common,
                api_key=credentials.get(provider_name, "api_key"),
                database=ordinary.database,
                edition=ordinary.edition,
            )
        raise MetadataRegistryError("implementation-mismatch", provider_name)
    if provider_name == ProviderName.CROSSREF.value:
        ordinary = configuration.sources.metadata.crossref
        if ordinary is None:
            raise MetadataRegistryError("missing-ordinary-parameter", provider_name)
        return CrossrefAdapter(**common, mailto=ordinary.mailto)
    return _build_fixed_adapter(provider_name, credentials, common)


def _validate_constructed_adapter(
    adapter: object,
    status: MetadataProviderStatus,
    dependencies: MetadataAssemblyDependencies,
) -> None:
    implementation = status.production_implementation
    if implementation is None or type(adapter) is not implementation:
        raise MetadataRegistryError("implementation-mismatch", status.provider_name)
    if getattr(adapter, "_http_client", None) is not dependencies.http_client:
        raise MetadataRegistryError("network-bypass", status.provider_name)
    if getattr(adapter, "_access_coordinator", None) is not dependencies.access_coordinator:
        raise MetadataRegistryError("network-bypass", status.provider_name)
    if getattr(adapter, "_access_scope", None) != status.access_scope:
        raise MetadataRegistryError("access-contract-mismatch", status.provider_name)
    effective_policy = getattr(adapter, "_access_policy", None)
    if not isinstance(effective_policy, AccessPolicy):
        raise MetadataRegistryError("missing-access-policy", status.provider_name)
    if status.access_policy is None or effective_policy != status.access_policy:
        raise MetadataRegistryError("access-contract-mismatch", status.provider_name)
    try:
        names = vars(adapter)
    except TypeError:
        names = {}
    if any("limiter" in name.casefold() for name in names):
        raise MetadataRegistryError("private-limiter-forbidden", status.provider_name)


def _validate_probe_adapter(
    adapter: object,
    provider: ProviderName,
    *,
    http_client: HttpClient | None = None,
    access_coordinator: AccessCoordinator | None = None,
) -> None:
    """Validate the explicit probe seam without invoking it."""

    if not isinstance(adapter, MetadataProbePort) or not callable(
        getattr(adapter, "probe_metadata", None)
    ):
        raise MetadataRegistryError("probe-port-missing", provider.value)
    try:
        actual_provider = adapter.provider_name
    except Exception:
        raise MetadataRegistryError("probe-provider-mismatch", provider.value) from None
    if actual_provider != provider.value:
        raise MetadataRegistryError("probe-provider-mismatch", provider.value)
    if http_client is None and access_coordinator is None:
        return
    if http_client is None or access_coordinator is None:
        raise MetadataRegistryError("probe-network-invalid", provider.value)
    if (
        getattr(http_client, "_coordinator", None) is not access_coordinator
        or getattr(adapter, "_http_client", None) is not http_client
        or getattr(adapter, "_access_coordinator", None) is not access_coordinator
    ):
        raise MetadataRegistryError("network-bypass", provider.value)


def _failed_probe_result(
    provider: ProviderName,
    capability: ProviderCapability,
    *,
    code: str,
    checks: tuple[bool | None, bool | None, bool | None, bool | None],
) -> ConfigurationProbeResult:
    return ConfigurationProbeResult(
        provider=provider,
        capability=capability,
        outcome=ProbeOutcome.FAILED,
        local_ready=True,
        network_reachable=checks[0],
        authentication_accepted=checks[1],
        api_product_usable=checks[2],
        minimal_response_parseable=checks[3],
        failure_code=code,
    )


def build_metadata_probe_registry(
    configuration: Configuration,
    credentials: CredentialLookup,
    dependencies: MetadataAssemblyDependencies,
) -> MetadataProbeRegistry:
    """Construct every locally ready production Metadata probe registration.

    Provider enablement is intentionally ignored here: a named ``config test``
    is allowed to test a disabled but fully configured Provider.  No probe,
    identifier factory, clock, resolver or transport is called during this
    assembly.
    """

    if not isinstance(dependencies, MetadataAssemblyDependencies):
        raise MetadataRegistryError("dependencies-invalid")
    if (
        getattr(dependencies.http_client, "_coordinator", None)
        is not dependencies.access_coordinator
    ):
        raise MetadataRegistryError("network-bypass")
    statuses = metadata_provider_statuses(configuration, credentials)
    registrations: list[MetadataProbeRegistration] = []
    for status in statuses:
        if not status.ready:
            continue
        try:
            adapter = _build_adapter(configuration, credentials, dependencies, status)
            _validate_constructed_adapter(adapter, status, dependencies)
            provider = ProviderName(status.provider_name)
            _validate_probe_adapter(
                adapter,
                provider,
                http_client=dependencies.http_client,
                access_coordinator=dependencies.access_coordinator,
            )
        except MetadataRegistryError:
            raise
        except Exception:
            raise MetadataRegistryError("probe-assembly-failed", status.provider_name) from None
        registrations.append(
            MetadataProbeRegistration(
                provider=provider,
                adapter=cast(MetadataProbePort, adapter),
            )
        )
    return MetadataProbeRegistry(
        registrations=tuple(registrations),
        http_client=dependencies.http_client,
        access_coordinator=dependencies.access_coordinator,
    )


def build_metadata_registry(
    configuration: Configuration,
    credentials: CredentialLookup,
    dependencies: MetadataAssemblyDependencies,
) -> MetadataRegistry:
    """Assemble enabled, ready adapters without performing a Provider call."""

    if not isinstance(dependencies, MetadataAssemblyDependencies):
        raise MetadataRegistryError("dependencies-invalid")
    if (
        getattr(dependencies.http_client, "_coordinator", None)
        is not dependencies.access_coordinator
    ):
        raise MetadataRegistryError("network-bypass")
    statuses = metadata_provider_statuses(configuration, credentials)
    status_by_name = {status.provider_name: status for status in statuses}
    selected = tuple(item.value for item in configuration.sources.metadata.providers)
    scan_limit = configuration.discovery.metadata_scan_limit
    discovery_capabilities = {
        MetadataCapability.TOPIC_SEARCH,
        MetadataCapability.REFERENCE_QUERY,
    }
    if scan_limit is None and any(
        discovery_capabilities.intersection(status_by_name[provider].capabilities)
        for provider in selected
    ):
        raise MetadataRegistryError("missing-scan-limit")

    registrations: list[MetadataProviderRegistration] = []
    topic_ports: list[TopicSearchPort] = []
    lookup_ports: list[MetadataLookupPort] = []
    reference_ports: list[ReferenceQueryPort] = []
    topic_limits: list[ProviderDiscoveryLimit] = []
    citation_limits: list[ProviderDiscoveryLimit] = []
    for provider_name in selected:
        status = status_by_name[provider_name]
        if not status.ready:
            raise MetadataRegistryError(
                status.failure_code or "readiness-failed",
                provider_name,
            )
        adapter = _build_adapter(configuration, credentials, dependencies, status)
        _validate_constructed_adapter(adapter, status, dependencies)
        provider_scan_limit = (
            scan_limit if discovery_capabilities.intersection(status.capabilities) else None
        )
        registrations.append(
            MetadataProviderRegistration(
                provider_name=provider_name,
                adapter=adapter,
                capabilities=status.capabilities,
                scan_limit=provider_scan_limit,
            )
        )
        if MetadataCapability.TOPIC_SEARCH in status.capabilities:
            if scan_limit is None:  # pragma: no cover - checked before assembly.
                raise MetadataRegistryError("missing-scan-limit", provider_name)
            topic_ports.append(cast(TopicSearchPort, adapter))
            topic_limits.append(
                ProviderDiscoveryLimit(
                    provider_name=provider_name,
                    scan_limit=scan_limit,
                )
            )
        if MetadataCapability.LOOKUP in status.capabilities:
            lookup_ports.append(cast(MetadataLookupPort, adapter))
        if MetadataCapability.REFERENCE_QUERY in status.capabilities:
            reference_ports.append(cast(ReferenceQueryPort, adapter))
            citation_limits.append(
                ProviderDiscoveryLimit(
                    provider_name=provider_name,
                    scan_limit=cast(int, scan_limit),
                )
            )

    return MetadataRegistry(
        statuses=statuses,
        registrations=tuple(registrations),
        topic_search_ports=tuple(topic_ports),
        lookup_ports=tuple(lookup_ports),
        reference_query_ports=tuple(reference_ports),
        topic_limits=tuple(topic_limits),
        citation_limits=tuple(citation_limits),
    )


__all__ = (
    "METADATA_PROVIDER_ORDER",
    "METADATA_SEARCH_PROVIDER_ORDER",
    "MetadataAssemblyDependencies",
    "MetadataCapability",
    "MetadataProviderRegistration",
    "MetadataProviderStatus",
    "MetadataProbeRegistration",
    "MetadataProbeRegistry",
    "MetadataRegistry",
    "MetadataRegistryError",
    "build_metadata_registry",
    "build_metadata_probe_registry",
    "metadata_provider_statuses",
    "validate_metadata_provider_matrix",
)
