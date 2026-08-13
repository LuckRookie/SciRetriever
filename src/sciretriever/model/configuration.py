"""Secret-free configuration data contracts.

The root :mod:`sciretriever.configuration` module owns TOML, environment and
credential parsing.  This module deliberately contains only immutable
Pydantic data structures: it does not read files, inspect the environment,
compute provider readiness, or retain a secret value.
"""

from __future__ import annotations

from enum import Enum
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator


def _nonblank(value: object) -> str:
    if type(value) is not str:
        raise ValueError("value must be a string")
    value = value.strip()
    if not value:
        raise ValueError("value must not be blank")
    return value


def _provider(value: object) -> "ProviderName":
    if isinstance(value, ProviderName):
        return value
    if type(value) is not str:
        raise ValueError("provider must be a string")
    try:
        return ProviderName(value)
    except ValueError as error:
        raise ValueError("provider is unsupported") from error


def _capability(value: object) -> "ProviderCapability":
    if isinstance(value, ProviderCapability):
        return value
    if type(value) is not str:
        raise ValueError("capability must be a string")
    try:
        return ProviderCapability(value)
    except ValueError as error:
        raise ValueError("capability is unsupported") from error


def _status(value: object) -> "CredentialStatus":
    if isinstance(value, CredentialStatus):
        return value
    if type(value) is not str:
        raise ValueError("status must be a string")
    try:
        return CredentialStatus(value)
    except ValueError as error:
        raise ValueError("status is unsupported") from error


def _web_of_science_product(value: object) -> "WebOfScienceProduct":
    if isinstance(value, WebOfScienceProduct):
        return value
    if type(value) is not str:
        raise ValueError("Web of Science product must be a string")
    try:
        return WebOfScienceProduct(value)
    except ValueError as error:
        raise ValueError("Web of Science product is unsupported") from error


def _crossref_access_mode(value: object) -> "CrossrefAccessMode":
    if isinstance(value, CrossrefAccessMode):
        return value
    if type(value) is not str:
        raise ValueError("Crossref access mode must be a string")
    try:
        return CrossrefAccessMode(value)
    except ValueError as error:
        raise ValueError("Crossref access mode is unsupported") from error


def _parser_connection_mode(value: object) -> "ParserConnectionMode":
    if isinstance(value, ParserConnectionMode):
        return value
    if type(value) is not str:
        raise ValueError("parser connection mode must be a string")
    try:
        return ParserConnectionMode(value)
    except ValueError as error:
        raise ValueError("parser connection mode is unsupported") from error


def _analysis_provider(value: object) -> "AnalysisProvider":
    if isinstance(value, AnalysisProvider):
        return value
    if type(value) is not str:
        raise ValueError("analysis provider must be a string")
    try:
        return AnalysisProvider(value)
    except ValueError as error:
        raise ValueError("analysis provider is unsupported") from error


def _probe_outcome(value: object) -> "ProbeOutcome":
    if isinstance(value, ProbeOutcome):
        return value
    if type(value) is not str:
        raise ValueError("probe outcome must be a string")
    try:
        return ProbeOutcome(value)
    except ValueError as error:
        raise ValueError("probe outcome is unsupported") from error


def _ordinary_parameter(value: object) -> str:
    candidate = _nonblank(value)
    if len(candidate) > 128 or any(
        ord(character) < 32 or ord(character) == 127 for character in candidate
    ):
        raise ValueError("ordinary provider parameter is invalid")
    return candidate


def _contact_email(value: object) -> str:
    candidate = _ordinary_parameter(value)
    local, separator, domain = candidate.partition("@")
    if (
        separator != "@"
        or candidate.count("@") != 1
        or not local
        or not domain
        or "." not in domain
        or domain.startswith(".")
        or domain.endswith(".")
        or any(character.isspace() for character in candidate)
    ):
        raise ValueError("contact email is invalid")
    try:
        candidate.encode("ascii", "strict")
    except UnicodeError:
        raise ValueError("contact email is invalid") from None
    return candidate


def _metadata_providers(value: object) -> tuple["ProviderName", ...]:
    if not isinstance(value, (list, tuple)):
        raise ValueError("metadata providers must be an array")
    result: list[ProviderName] = []
    for item in value:
        provider = _provider(item)
        if provider not in _METADATA_PROVIDER_NAMES:
            raise ValueError("metadata provider is unsupported")
        if provider in result:
            raise ValueError("metadata providers must be unique")
        result.append(provider)
    return tuple(result)


def _acquisition_providers(value: object) -> tuple["ProviderName", ...]:
    if not isinstance(value, (list, tuple)):
        raise ValueError("acquisition providers must be an array")
    result: list[ProviderName] = []
    for item in value:
        provider = _provider(item)
        if provider not in _ACQUISITION_PROVIDER_NAMES:
            raise ValueError("acquisition provider is unsupported")
        if provider in result:
            raise ValueError("acquisition providers must be unique")
        result.append(provider)
    return tuple(result)


class _FrozenModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        populate_by_name=True,
        strict=True,
    )


class ProviderName(str, Enum):
    """Provider keys from the accepted Metadata/Acquisition matrix."""

    WEB_OF_SCIENCE = "web-of-science"
    CROSSREF = "crossref"
    SEMANTIC_SCHOLAR = "semantic-scholar"
    ARXIV = "arxiv"
    OPENALEX = "openalex"
    EUROPE_PMC = "europe-pmc"
    ELSEVIER = "elsevier"
    SPRINGER = "springer"
    DATACITE = "datacite"
    CORE = "core"
    OPENCITATIONS = "opencitations"
    UNPAYWALL = "unpaywall"
    WILEY = "wiley"
    SCI_HUB = "sci-hub"


class ProviderCapability(str, Enum):
    METADATA = "metadata"
    ACQUISITION = "acquisition"


class CredentialStatus(str, Enum):
    NOT_REQUIRED = "not-required"
    CONFIGURED = "configured"
    PARTIAL = "partial"
    MISSING = "missing"
    OPTIONAL_MISSING = "optional-missing"
    UNSUPPORTED = "unsupported"


class WebOfScienceProduct(str, Enum):
    """The two accepted Web of Science Metadata products."""

    STARTER = "starter"
    EXPANDED = "expanded"


class CrossrefAccessMode(str, Enum):
    """An explicit choice between Crossref's public and polite pools."""

    ANONYMOUS = "anonymous"
    POLITE = "polite"


class ParserConnectionMode(str, Enum):
    """The two accepted deployment boundaries for MinerU protocol 2."""

    LOOPBACK = "loopback"
    REMOTE = "remote"


class AnalysisProvider(str, Enum):
    """The fixed production Analysis adapters."""

    OPENAI = "openai"
    ANTHROPIC = "anthropic"


class ProbeOutcome(str, Enum):
    """Stable result of one explicit, non-persistent provider probe."""

    PASSED = "passed"
    FAILED = "failed"
    SKIPPED = "skipped"


_METADATA_PROVIDER_NAMES = frozenset(
    {
        ProviderName.WEB_OF_SCIENCE,
        ProviderName.CROSSREF,
        ProviderName.SEMANTIC_SCHOLAR,
        ProviderName.ARXIV,
        ProviderName.OPENALEX,
        ProviderName.EUROPE_PMC,
        ProviderName.ELSEVIER,
        ProviderName.SPRINGER,
        ProviderName.DATACITE,
        ProviderName.CORE,
        ProviderName.OPENCITATIONS,
    }
)

_ACQUISITION_PROVIDER_NAMES = frozenset(
    {
        ProviderName.ARXIV,
        ProviderName.CROSSREF,
        ProviderName.SEMANTIC_SCHOLAR,
        ProviderName.OPENALEX,
        ProviderName.EUROPE_PMC,
        ProviderName.UNPAYWALL,
        ProviderName.ELSEVIER,
        ProviderName.SPRINGER,
        ProviderName.WILEY,
        ProviderName.DATACITE,
        ProviderName.CORE,
        ProviderName.SCI_HUB,
    }
)

_CONFIGURATION_CAPABILITY_ORDER: tuple[tuple[ProviderName, ProviderCapability], ...] = (
    (ProviderName.WEB_OF_SCIENCE, ProviderCapability.METADATA),
    (ProviderName.CROSSREF, ProviderCapability.METADATA),
    (ProviderName.CROSSREF, ProviderCapability.ACQUISITION),
    (ProviderName.SEMANTIC_SCHOLAR, ProviderCapability.METADATA),
    (ProviderName.SEMANTIC_SCHOLAR, ProviderCapability.ACQUISITION),
    (ProviderName.ARXIV, ProviderCapability.METADATA),
    (ProviderName.ARXIV, ProviderCapability.ACQUISITION),
    (ProviderName.OPENALEX, ProviderCapability.METADATA),
    (ProviderName.OPENALEX, ProviderCapability.ACQUISITION),
    (ProviderName.EUROPE_PMC, ProviderCapability.METADATA),
    (ProviderName.EUROPE_PMC, ProviderCapability.ACQUISITION),
    (ProviderName.ELSEVIER, ProviderCapability.METADATA),
    (ProviderName.ELSEVIER, ProviderCapability.ACQUISITION),
    (ProviderName.SPRINGER, ProviderCapability.METADATA),
    (ProviderName.SPRINGER, ProviderCapability.ACQUISITION),
    (ProviderName.DATACITE, ProviderCapability.METADATA),
    (ProviderName.DATACITE, ProviderCapability.ACQUISITION),
    (ProviderName.CORE, ProviderCapability.METADATA),
    (ProviderName.CORE, ProviderCapability.ACQUISITION),
    (ProviderName.OPENCITATIONS, ProviderCapability.METADATA),
    (ProviderName.UNPAYWALL, ProviderCapability.ACQUISITION),
    (ProviderName.WILEY, ProviderCapability.ACQUISITION),
    (ProviderName.SCI_HUB, ProviderCapability.ACQUISITION),
)


NonBlankText = Annotated[
    str,
    BeforeValidator(_nonblank),
    Field(strict=True, min_length=1, max_length=4096),
]
ProviderValue = Annotated[ProviderName, BeforeValidator(_provider)]
CapabilityValue = Annotated[ProviderCapability, BeforeValidator(_capability)]
StatusValue = Annotated[CredentialStatus, BeforeValidator(_status)]
WebOfScienceProductValue = Annotated[
    WebOfScienceProduct,
    BeforeValidator(_web_of_science_product),
]
CrossrefAccessModeValue = Annotated[
    CrossrefAccessMode,
    BeforeValidator(_crossref_access_mode),
]
ParserConnectionModeValue = Annotated[
    ParserConnectionMode,
    BeforeValidator(_parser_connection_mode),
]
AnalysisProviderValue = Annotated[
    AnalysisProvider,
    BeforeValidator(_analysis_provider),
]
ProbeOutcomeValue = Annotated[ProbeOutcome, BeforeValidator(_probe_outcome)]
ConfigurationFingerprint = Annotated[
    str,
    Field(strict=True, pattern=r"^sha256:[0-9a-f]{64}$"),
]
StableFailureCode = Annotated[
    str,
    Field(
        strict=True,
        min_length=1,
        max_length=128,
        pattern=r"^[a-z][a-z0-9-]{0,127}$",
    ),
]
OrdinaryProviderParameter = Annotated[
    str,
    BeforeValidator(_ordinary_parameter),
    Field(strict=True, min_length=1, max_length=128),
]
ContactEmail = Annotated[
    str,
    BeforeValidator(_contact_email),
    Field(strict=True, min_length=3, max_length=128),
]
MetadataProviderTuple = Annotated[
    tuple[ProviderName, ...],
    BeforeValidator(_metadata_providers),
]
AcquisitionProviderTuple = Annotated[
    tuple[ProviderName, ...],
    BeforeValidator(_acquisition_providers),
]


class PathsConfig(_FrozenModel):
    """The two roots owned by the production object graph."""

    catalog_path: NonBlankText | None = None
    artifact_root: NonBlankText | None = None


class DiscoveryConfig(_FrozenModel):
    metadata_scan_limit: Annotated[int, Field(strict=True, ge=1)] | None = None


class WebOfScienceMetadataConfig(_FrozenModel):
    """Non-secret Web of Science product selection and collection context."""

    product: WebOfScienceProductValue
    database: OrdinaryProviderParameter
    edition: OrdinaryProviderParameter | None = None


class CrossrefMetadataConfig(_FrozenModel):
    """Explicit Crossref public/polite identity selection."""

    mode: CrossrefAccessModeValue
    mailto: ContactEmail | None = None

    @model_validator(mode="after")
    def _validate_identity_choice(self) -> "CrossrefMetadataConfig":
        if self.mode is CrossrefAccessMode.POLITE and self.mailto is None:
            raise ValueError("Crossref polite mode requires mailto")
        if self.mode is CrossrefAccessMode.ANONYMOUS and self.mailto is not None:
            raise ValueError("Crossref anonymous mode forbids mailto")
        return self


class MetadataSourcesConfig(_FrozenModel):
    """Ordered enabled Metadata providers and their required ordinary inputs."""

    providers: MetadataProviderTuple = ()
    web_of_science: WebOfScienceMetadataConfig | None = Field(
        default=None,
        alias="web-of-science",
    )
    crossref: CrossrefMetadataConfig | None = None


class UnpaywallAcquisitionConfig(_FrozenModel):
    """The non-secret contact identity required by Unpaywall."""

    contact_email: ContactEmail


class AcquisitionSourcesConfig(_FrozenModel):
    """Ordered enabled Acquisition providers and their ordinary inputs."""

    providers: AcquisitionProviderTuple = ()
    unpaywall: UnpaywallAcquisitionConfig | None = None


class SourcesConfig(_FrozenModel):
    metadata: MetadataSourcesConfig = MetadataSourcesConfig()
    acquisition: AcquisitionSourcesConfig = AcquisitionSourcesConfig()


class AssetsConfig(_FrozenModel):
    pass


class ParsingConfig(_FrozenModel):
    """Non-secret MinerU deployment selection.

    MinerU release 3.4.4, protocol 2, profile ``vlm-engine`` and archive
    backend ``vlm`` are implementation facts, not operator choices.
    """

    base_url: NonBlankText | None = None
    connection_mode: ParserConnectionModeValue | None = None
    model_identity: NonBlankText | None = None
    remote_upload_authorized: bool = False

    @model_validator(mode="after")
    def _validate_upload_boundary(self) -> "ParsingConfig":
        if self.connection_mode is ParserConnectionMode.LOOPBACK and self.remote_upload_authorized:
            raise ValueError("loopback parsing forbids remote upload authorization")
        return self


class AnalysisConfig(_FrozenModel):
    """Non-secret fixed-provider Analysis construction parameters."""

    provider: AnalysisProviderValue | None = None
    model: NonBlankText | None = None
    metadata_max_output_tokens: Annotated[int, Field(strict=True, ge=1)] | None = None
    content_max_output_tokens: Annotated[int, Field(strict=True, ge=1)] | None = None
    reference_max_output_tokens: Annotated[int, Field(strict=True, ge=1)] | None = None
    max_input_bytes: Annotated[int, Field(strict=True, ge=1)] | None = None
    max_chunk_bytes: Annotated[int, Field(strict=True, ge=1)] | None = None
    max_chunk_count: Annotated[int, Field(strict=True, ge=1)] | None = None
    max_total_llm_requests: Annotated[int, Field(strict=True, ge=1)] | None = None
    max_total_output_tokens: Annotated[int, Field(strict=True, ge=1)] | None = None


class ExecutionConfig(_FrozenModel):
    max_concurrency: Annotated[int, Field(strict=True, ge=1, le=64)] = 4


class LibraryConfig(_FrozenModel):
    max_input_bytes: Annotated[
        int,
        Field(strict=True, ge=1_024, le=1_073_741_824),
    ] = 67_108_864


class AccessConfig(_FrozenModel):
    pass


class Configuration(_FrozenModel):
    """Ordinary configuration with exactly nine accepted responsibility groups."""

    paths: PathsConfig = PathsConfig()
    discovery: DiscoveryConfig = DiscoveryConfig()
    sources: SourcesConfig = SourcesConfig()
    assets: AssetsConfig = AssetsConfig()
    parsing: ParsingConfig = ParsingConfig()
    analysis: AnalysisConfig = AnalysisConfig()
    execution: ExecutionConfig = ExecutionConfig()
    library: LibraryConfig = LibraryConfig()
    access: AccessConfig = AccessConfig()


class CredentialFieldSpec(_FrozenModel):
    """A non-secret description of an accepted provider field."""

    name: NonBlankText
    required: bool


class CredentialFieldStatus(_FrozenModel):
    """Presence metadata only; no secret value or secret characteristic."""

    name: NonBlankText
    required: bool
    present: bool


class ProviderCredentialStatus(_FrozenModel):
    """A secret-free readiness/status result for one provider capability."""

    provider: ProviderValue
    capability: CapabilityValue
    status: StatusValue
    fields: Annotated[tuple[CredentialFieldStatus, ...], Field(min_length=0)] = ()


class ConfigurationDiagnostic(_FrozenModel):
    """Local configuration diagnostics, separate from Entry Reports."""

    provider: ProviderValue
    capabilities: Annotated[tuple[ProviderCredentialStatus, ...], Field(min_length=1)]


class ConfigurationCapabilityStatus(_FrozenModel):
    """Independent local readiness layers for one provider capability."""

    provider: ProviderValue
    capability: CapabilityValue
    production_available: bool
    enabled: bool
    ordinary_parameters_ready: bool
    credential: ProviderCredentialStatus
    access_policy_ready: bool
    probe_available: bool = False
    local_ready: bool
    failure_code: StableFailureCode | None = None

    @model_validator(mode="after")
    def _validate_local_readiness(self) -> "ConfigurationCapabilityStatus":
        if self.local_ready == (self.failure_code is not None):
            raise ValueError("local readiness failure code is inconsistent")
        if self.credential.provider is not self.provider:
            raise ValueError("credential provider is inconsistent")
        if self.credential.capability is not self.capability:
            raise ValueError("credential capability is inconsistent")
        if not self.production_available and self.local_ready:
            raise ValueError("production availability is inconsistent")
        if self.local_ready and (
            not self.ordinary_parameters_ready or not self.access_policy_ready
        ):
            raise ValueError("local readiness layers are inconsistent")
        return self


class ConfigurationStatus(_FrozenModel):
    """Purely local, secret-free status for the accepted provider matrix."""

    configuration_fingerprint: ConfigurationFingerprint
    capabilities: Annotated[
        tuple[ConfigurationCapabilityStatus, ...],
        Field(min_length=len(_CONFIGURATION_CAPABILITY_ORDER)),
    ]

    @model_validator(mode="after")
    def _validate_capability_matrix(self) -> "ConfigurationStatus":
        keys = tuple((item.provider, item.capability) for item in self.capabilities)
        if keys != _CONFIGURATION_CAPABILITY_ORDER:
            raise ValueError("configuration capability status matrix is invalid")
        return self


class ConfigurationProbeResult(_FrozenModel):
    """One explicit probe result without response, URL, time, or exception data."""

    provider: ProviderValue
    capability: CapabilityValue
    outcome: ProbeOutcomeValue
    local_ready: bool
    network_reachable: bool | None = None
    authentication_accepted: bool | None = None
    api_product_usable: bool | None = None
    minimal_response_parseable: bool | None = None
    acquisition_entitlement: Annotated[str, Field(strict=True, pattern="^not-proven$")] = (
        "not-proven"
    )
    failure_code: StableFailureCode | None = None

    @model_validator(mode="after")
    def _validate_probe_shape(self) -> "ConfigurationProbeResult":
        checks = (
            self.network_reachable,
            self.authentication_accepted,
            self.api_product_usable,
            self.minimal_response_parseable,
        )
        if self.outcome is ProbeOutcome.SKIPPED:
            if (
                self.local_ready
                or any(value is not None for value in checks)
                or self.failure_code is None
            ):
                raise ValueError("skipped probe result is inconsistent")
            return self
        if not self.local_ready:
            raise ValueError("executed probe result is inconsistent")
        if self.outcome is ProbeOutcome.PASSED:
            if checks != (True, True, True, True) or self.failure_code is not None:
                raise ValueError("passed probe result is inconsistent")
            return self
        if self.failure_code is None or checks == (True, True, True, True):
            raise ValueError("non-passed probe requires a failure code")
        # Checks are sequential.  Once one layer is false or unknown, a later
        # layer cannot be asserted: e.g. an authentication rejection cannot
        # also prove product usability or response parsing.
        terminal_seen = False
        for value in checks:
            if terminal_seen and value is not None:
                raise ValueError("failed probe checks are not sequential")
            if value is not True:
                terminal_seen = True
        return self


class ConfigurationProbeSummary(_FrozenModel):
    """Ordered, non-persistent result of an explicit configuration test."""

    results: tuple[ConfigurationProbeResult, ...] = ()

    @property
    def passed(self) -> bool:
        return all(result.outcome is ProbeOutcome.PASSED for result in self.results)


__all__ = (
    "AccessConfig",
    "AcquisitionProviderTuple",
    "AcquisitionSourcesConfig",
    "AnalysisConfig",
    "AnalysisProvider",
    "AssetsConfig",
    "Configuration",
    "ConfigurationCapabilityStatus",
    "ConfigurationDiagnostic",
    "ConfigurationFingerprint",
    "ConfigurationProbeResult",
    "ConfigurationProbeSummary",
    "ConfigurationStatus",
    "ContactEmail",
    "CrossrefAccessMode",
    "CrossrefMetadataConfig",
    "CredentialFieldSpec",
    "CredentialFieldStatus",
    "CredentialStatus",
    "DiscoveryConfig",
    "ExecutionConfig",
    "LibraryConfig",
    "MetadataProviderTuple",
    "MetadataSourcesConfig",
    "OrdinaryProviderParameter",
    "ParsingConfig",
    "ParserConnectionMode",
    "PathsConfig",
    "ProviderCapability",
    "ProviderCredentialStatus",
    "ProviderName",
    "ProbeOutcome",
    "SourcesConfig",
    "StableFailureCode",
    "UnpaywallAcquisitionConfig",
    "WebOfScienceMetadataConfig",
    "WebOfScienceProduct",
)
