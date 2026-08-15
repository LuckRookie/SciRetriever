"""Secret-free configuration data contracts.

The root :mod:`sciretriever.configuration` module owns TOML, environment and
credential parsing.  This module deliberately contains only immutable
Pydantic data structures: it does not read files, inspect the environment,
compute provider readiness, or retain a secret value.
"""

from __future__ import annotations

import ipaddress
import math
import re
import unicodedata
from enum import Enum
from typing import Annotated, Literal
from urllib.parse import unquote_to_bytes, urlsplit

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)


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


def _analysis_protocol(value: object) -> "AnalysisProtocol":
    if isinstance(value, AnalysisProtocol):
        return value
    if type(value) is not str:
        raise ValueError("analysis protocol must be a string")
    try:
        return AnalysisProtocol(value)
    except ValueError as error:
        raise ValueError("analysis protocol is unsupported") from error


def _analysis_authentication(value: object) -> "AnalysisAuthentication":
    if isinstance(value, AnalysisAuthentication):
        return value
    if type(value) is not str:
        raise ValueError("analysis authentication must be a string")
    try:
        return AnalysisAuthentication(value)
    except ValueError as error:
        raise ValueError("analysis authentication is unsupported") from error


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


_BROWSER_IDENTITY = re.compile(
    r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
    re.ASCII,
)
_BROWSER_UUID_IDENTITY = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.ASCII,
)
_BROWSER_SENSITIVE_IDENTITY_MARKERS = frozenset(
    {
        "authorization",
        "cookie",
        "credential",
        "password",
        "private",
        "secret",
        "signature",
        "token",
    }
)


def _browser_identity(value: object, *, field_name: str) -> str:
    if type(value) is not str:
        raise ValueError(f"{field_name} must be a string")
    candidate = value.strip().casefold()
    if (
        len(candidate) > 96
        or _BROWSER_IDENTITY.fullmatch(candidate) is None
        or _BROWSER_UUID_IDENTITY.fullmatch(candidate) is not None
        or any(marker in candidate.split("-") for marker in _BROWSER_SENSITIVE_IDENTITY_MARKERS)
    ):
        raise ValueError(f"{field_name} must be a stable non-sensitive identity")
    return candidate


def normalize_browser_profile_identity(value: object) -> str:
    """Normalize one opaque profile identity without accepting a path."""

    return _browser_identity(value, field_name="Browser profile identity")


def _browser_rate_limit_group(value: object) -> str:
    return _browser_identity(value, field_name="Browser rate-limit group")


def _finite_nonnegative_number(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Browser policy value must be a number")
    candidate = float(value)
    if not math.isfinite(candidate) or candidate < 0.0:
        raise ValueError("Browser policy value must be finite and nonnegative")
    return candidate


def _finite_positive_number(value: object) -> float:
    candidate = _finite_nonnegative_number(value)
    if candidate == 0.0:
        raise ValueError("Browser policy value must be positive")
    return candidate


def _service_identity(value: object) -> str:
    candidate = _ordinary_parameter(value)
    if (
        not all(
            character.isascii() and (character.isalnum() or character in {"-", "_", "."})
            for character in candidate
        )
        or not candidate[0].isalnum()
    ):
        raise ValueError("service identity is invalid")
    return candidate.casefold()


_SERVICE_DNS_LABEL = re.compile(
    r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?",
    re.ASCII,
)
_SERVICE_LEGACY_IPV4 = re.compile(r"[0-9A-Fa-fxX.]+", re.ASCII)
_SERVICE_HEX = frozenset("0123456789abcdefABCDEF")


def _service_hostname(
    value: str,
) -> tuple[str, ipaddress.IPv4Address | ipaddress.IPv6Address | None]:
    if not value or value.endswith(".") or "%" in value:
        raise ValueError("service Base URL is invalid")
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        if _SERVICE_LEGACY_IPV4.fullmatch(value) is not None:
            raise ValueError("service Base URL is invalid") from None
        try:
            hostname = value.encode("idna").decode("ascii").casefold()
            labels = hostname.split(".")
            if (
                len(hostname) > 253
                or any(_SERVICE_DNS_LABEL.fullmatch(label) is None for label in labels)
                or any(
                    label.encode("ascii").decode("idna").encode("idna").decode("ascii").casefold()
                    != label
                    for label in labels
                )
            ):
                raise ValueError
        except (UnicodeError, ValueError):
            raise ValueError("service Base URL is invalid") from None
        return hostname, None
    canonical = str(address)
    if canonical.casefold() != value.casefold():
        raise ValueError("service Base URL is invalid")
    return canonical, address


def _validate_service_port_text(netloc: str, port: int | None) -> None:
    if port is None:
        return
    if netloc.startswith("["):
        closing = netloc.find("]")
        if closing < 0:
            raise ValueError("service Base URL is invalid")
        suffix = netloc[closing + 1 :]
        if suffix and (not suffix.startswith(":") or suffix[1:] != str(port)):
            raise ValueError("service Base URL is invalid")
        return
    if ":" in netloc and netloc.rsplit(":", 1)[1] != str(port):
        raise ValueError("service Base URL is invalid")


def _validate_service_path(path: str) -> None:
    candidate = path or "/"
    index = 0
    while index < len(candidate):
        if candidate[index] != "%":
            index += 1
            continue
        if (
            index + 2 >= len(candidate)
            or candidate[index + 1] not in _SERVICE_HEX
            or candidate[index + 2] not in _SERVICE_HEX
        ):
            raise ValueError("service Base URL is invalid")
        index += 3
    if re.search(r"%(?:2f|5c)", candidate, re.IGNORECASE):
        raise ValueError("service Base URL is invalid")
    try:
        decoded = unquote_to_bytes(candidate).decode("utf-8", "strict")
    except UnicodeDecodeError:
        raise ValueError("service Base URL is invalid") from None
    normalized = decoded.replace("\\", "/")
    if (
        "\\" in candidate
        or "//" in normalized
        or any(segment in {".", ".."} for segment in normalized.split("/"))
    ):
        raise ValueError("service Base URL is invalid")


def _service_url(value: str) -> tuple[str, str, int, str, bool]:
    """Validate a secret-free service URL and classify its host locally.

    Network adapters perform the canonical URL and destination-policy check
    again before any request.  The Model check exists so invalid ordinary
    configuration cannot be reported as locally complete.
    """

    if "\\" in value or any(
        character.isspace() or unicodedata.category(character) in {"Cc", "Cf"}
        for character in value
    ):
        raise ValueError("service Base URL is invalid")
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except (UnicodeError, ValueError):
        raise ValueError("service Base URL is invalid") from None
    scheme = parsed.scheme.casefold()
    if (
        scheme not in {"http", "https"}
        or hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("service Base URL is invalid")
    _validate_service_port_text(parsed.netloc, port)
    hostname, address = _service_hostname(hostname.casefold())
    _validate_service_path(parsed.path)
    loopback = hostname == "localhost" or bool(address is not None and address.is_loopback)
    if scheme == "http" and not loopback:
        raise ValueError("remote service Base URL must use HTTPS")
    return scheme, hostname, port or (443 if scheme == "https" else 80), parsed.path, loopback


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


class BrowserProfilePresence(str, Enum):
    """The only local disclosures allowed for a sensitive Browser profile."""

    CONFIGURED = "configured"
    MISSING = "missing"
    ATTENTION = "attention"


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
    CUSTOM = "custom"


class AnalysisProtocol(str, Enum):
    """The three explicit structured-output wire protocols."""

    OPENAI_RESPONSES = "openai-responses"
    OPENAI_CHAT_COMPLETIONS = "openai-chat-completions"
    ANTHROPIC_MESSAGES = "anthropic-messages"


class AnalysisAuthentication(str, Enum):
    """Explicit authentication choice for the selected LLM service."""

    API_KEY = "api-key"
    NONE = "none"


class CoreCredentialService(str, Enum):
    """The two non-Provider secret sections in credentials.toml."""

    LLM = "llm"
    MINERU = "mineru"


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
AnalysisProtocolValue = Annotated[
    AnalysisProtocol,
    BeforeValidator(_analysis_protocol),
]
AnalysisAuthenticationValue = Annotated[
    AnalysisAuthentication,
    BeforeValidator(_analysis_authentication),
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
ServiceIdentity = Annotated[
    str,
    BeforeValidator(_service_identity),
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
BrowserProfileIdentity = Annotated[
    str,
    BeforeValidator(normalize_browser_profile_identity),
    Field(strict=True, min_length=1, max_length=96),
]
BrowserRateLimitGroupValue = Annotated[
    str,
    BeforeValidator(_browser_rate_limit_group),
    Field(strict=True, min_length=1, max_length=96),
]
FiniteNonnegativeBrowserPolicyValue = Annotated[
    float,
    BeforeValidator(_finite_nonnegative_number),
]
FinitePositiveBrowserPolicyValue = Annotated[
    float,
    BeforeValidator(_finite_positive_number),
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
        if (
            self.connection_mode is not ParserConnectionMode.REMOTE
            and self.remote_upload_authorized
        ):
            raise ValueError("only remote parsing accepts upload authorization")
        if self.base_url is not None:
            scheme, hostname, _port, _path, loopback = _service_url(self.base_url)
            try:
                address = ipaddress.ip_address(hostname)
            except ValueError:
                address = None
            if self.connection_mode is ParserConnectionMode.LOOPBACK and (
                not loopback or scheme != "http"
            ):
                raise ValueError("loopback parsing requires an HTTP loopback Base URL")
            if self.connection_mode is ParserConnectionMode.REMOTE and (
                loopback or address is not None or scheme != "https"
            ):
                raise ValueError("remote parsing requires a hostname-based HTTPS Base URL")
        return self


def _validate_analysis_protocol_choice(
    provider: AnalysisProvider | None,
    protocol: AnalysisProtocol | None,
) -> None:
    if provider is AnalysisProvider.OPENAI and protocol not in {
        None,
        AnalysisProtocol.OPENAI_RESPONSES,
        AnalysisProtocol.OPENAI_CHAT_COMPLETIONS,
    }:
        raise ValueError("OpenAI provider requires an OpenAI protocol")
    if provider is AnalysisProvider.ANTHROPIC and protocol not in {
        None,
        AnalysisProtocol.ANTHROPIC_MESSAGES,
    }:
        raise ValueError("Anthropic provider requires the Anthropic protocol")


def _validate_official_analysis_url(
    provider: AnalysisProvider | None,
    *,
    scheme: str,
    hostname: str,
    port: int,
    path: str,
) -> None:
    if provider is AnalysisProvider.OPENAI:
        official = "api.openai.com"
    elif provider is AnalysisProvider.ANTHROPIC:
        official = "api.anthropic.com"
    else:
        return
    if scheme != "https" or hostname != official or port != 443 or path.rstrip("/") != "/v1":
        label = "OpenAI" if provider is AnalysisProvider.OPENAI else "Anthropic"
        raise ValueError(f"{label} provider requires the official Base URL")


def _validate_analysis_service_choice(
    *,
    provider: AnalysisProvider | None,
    service_name: str | None,
    protocol: AnalysisProtocol | None,
    base_url: str | None,
    model: str | None,
    context_window_tokens: int | None,
    authentication: AnalysisAuthentication | None,
) -> None:
    custom_values = (protocol, base_url, model, context_window_tokens, authentication)
    if (
        provider is AnalysisProvider.CUSTOM
        and service_name is None
        and any(value is not None for value in custom_values)
    ):
        raise ValueError("custom Analysis service requires a service name")
    if provider is not AnalysisProvider.CUSTOM and service_name is not None:
        raise ValueError("official Analysis providers do not accept a custom service name")
    if base_url is None:
        return
    scheme, hostname, port, path, loopback = _service_url(base_url)
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if loopback and scheme != "http":
        raise ValueError("loopback Analysis requires an HTTP Base URL")
    if not loopback and address is not None:
        raise ValueError("remote Analysis requires a hostname-based HTTPS Base URL")
    _validate_official_analysis_url(
        provider,
        scheme=scheme,
        hostname=hostname,
        port=port,
        path=path,
    )
    if authentication is AnalysisAuthentication.NONE and (
        provider is not AnalysisProvider.CUSTOM or not loopback
    ):
        raise ValueError("unauthenticated Analysis is limited to a custom loopback service")
    if loopback and authentication is AnalysisAuthentication.API_KEY:
        raise ValueError("loopback Analysis does not send API-key credentials")


def _validate_analysis_budget_choice(
    *,
    context_window_tokens: int | None,
    max_input_bytes: int | None,
    max_chunk_bytes: int | None,
    max_total_llm_requests: int | None,
    max_total_output_tokens: int | None,
    output_tokens: tuple[int | None, ...],
) -> None:
    if (
        max_input_bytes is not None
        and max_chunk_bytes is not None
        and max_chunk_bytes > max_input_bytes
    ):
        raise ValueError("Analysis chunk budget must fit the input budget")
    if max_total_llm_requests is not None and max_total_llm_requests < 2:
        raise ValueError("Analysis request budget must cover the two-stage content workflow")
    configured_outputs = tuple(value for value in output_tokens if value is not None)
    if max_total_output_tokens is not None:
        if any(value > max_total_output_tokens for value in configured_outputs):
            raise ValueError("Analysis stage output must fit the total output budget")
        metadata_output, content_output, _reference_output = output_tokens
        if (
            metadata_output is not None
            and content_output is not None
            and metadata_output + content_output > max_total_output_tokens
        ):
            raise ValueError("Analysis content stages must fit the total output budget")
    if context_window_tokens is None:
        return
    if any(value >= context_window_tokens for value in configured_outputs):
        raise ValueError("Analysis output budget must fit the context window")
    if max_chunk_bytes is not None:
        # Until a provider tokenizer is introduced, three UTF-8 bytes per
        # token is the deliberately conservative planning estimate.  The
        # adapter repeats the check against the actual serialized request.
        input_tokens = (max_chunk_bytes + 2) // 3
        reserve = max(configured_outputs, default=0)
        if input_tokens + reserve > context_window_tokens:
            raise ValueError("Analysis chunk budget must fit the context window")


class AnalysisConfig(_FrozenModel):
    """Non-secret Analysis service, protocol, model, and budget selection."""

    provider: AnalysisProviderValue | None = None
    service_name: ServiceIdentity | None = None
    protocol: AnalysisProtocolValue | None = None
    base_url: NonBlankText | None = None
    model: NonBlankText | None = None
    context_window_tokens: Annotated[int, Field(strict=True, ge=1_024)] | None = None
    authentication: AnalysisAuthenticationValue | None = None
    metadata_max_output_tokens: Annotated[int, Field(strict=True, ge=1)] | None = None
    content_max_output_tokens: Annotated[int, Field(strict=True, ge=1)] | None = None
    reference_max_output_tokens: Annotated[int, Field(strict=True, ge=1)] | None = None
    max_input_bytes: Annotated[int, Field(strict=True, ge=1)] | None = None
    max_chunk_bytes: Annotated[int, Field(strict=True, ge=1)] | None = None
    max_chunk_count: Annotated[int, Field(strict=True, ge=1)] | None = None
    max_total_llm_requests: Annotated[int, Field(strict=True, ge=1)] | None = None
    max_total_output_tokens: Annotated[int, Field(strict=True, ge=1)] | None = None

    @model_validator(mode="after")
    def _validate_protocol_and_budgets(self) -> "AnalysisConfig":
        _validate_analysis_protocol_choice(self.provider, self.protocol)
        _validate_analysis_service_choice(
            provider=self.provider,
            service_name=self.service_name,
            protocol=self.protocol,
            base_url=self.base_url,
            model=self.model,
            context_window_tokens=self.context_window_tokens,
            authentication=self.authentication,
        )
        if (
            self.provider in {AnalysisProvider.OPENAI, AnalysisProvider.ANTHROPIC}
            and self.authentication is AnalysisAuthentication.NONE
        ):
            raise ValueError("official Analysis providers require API-key authentication")
        _validate_analysis_budget_choice(
            context_window_tokens=self.context_window_tokens,
            max_input_bytes=self.max_input_bytes,
            max_chunk_bytes=self.max_chunk_bytes,
            max_total_llm_requests=self.max_total_llm_requests,
            max_total_output_tokens=self.max_total_output_tokens,
            output_tokens=(
                self.metadata_max_output_tokens,
                self.content_max_output_tokens,
                self.reference_max_output_tokens,
            ),
        )
        return self


class ExecutionConfig(_FrozenModel):
    max_concurrency: Annotated[int, Field(strict=True, ge=1, le=64)] = 4


class LibraryConfig(_FrozenModel):
    max_input_bytes: Annotated[
        int,
        Field(strict=True, ge=1_024, le=1_073_741_824),
    ] = 67_108_864


class BrowserPolicyOverrideConfig(_FrozenModel):
    """Operator values that may only tighten one declared Browser group policy."""

    rate_limit_group: BrowserRateLimitGroupValue
    max_concurrency: Annotated[int, Field(strict=True, ge=1, le=1)] | None = None
    minimum_start_interval: FiniteNonnegativeBrowserPolicyValue | None = None
    maximum_starts_per_window: Annotated[int, Field(strict=True, ge=1)] | None = None
    window_seconds: FinitePositiveBrowserPolicyValue | None = None
    cooldown_after_completion: FiniteNonnegativeBrowserPolicyValue | None = None
    rate_limit_cooldown: FinitePositiveBrowserPolicyValue | None = None
    failure_cooldown: FiniteNonnegativeBrowserPolicyValue | None = None
    runtime_failure_threshold: Annotated[int, Field(strict=True, ge=1)] | None = None

    @model_validator(mode="after")
    def _validate_override_shape(self) -> "BrowserPolicyOverrideConfig":
        if (self.maximum_starts_per_window is None) != (self.window_seconds is None):
            raise ValueError("Browser policy window count and duration must be configured together")
        if all(
            value is None
            for value in (
                self.max_concurrency,
                self.minimum_start_interval,
                self.maximum_starts_per_window,
                self.cooldown_after_completion,
                self.rate_limit_cooldown,
                self.failure_cooldown,
                self.runtime_failure_threshold,
            )
        ):
            raise ValueError("Browser policy override must contain a limit")
        return self


class AccessConfig(_FrozenModel):
    """Secret-free Browser enablement, local cap, profile selection, and tightening."""

    browser_enabled: bool = False
    browser_profile: BrowserProfileIdentity | None = None
    browser_max_concurrency: Annotated[int, Field(strict=True, ge=1)] = 2
    browser_policy_overrides: tuple[BrowserPolicyOverrideConfig, ...] = ()

    @field_validator("browser_policy_overrides", mode="before")
    @classmethod
    def _normalize_policy_overrides(cls, value: object) -> object:
        return tuple(value) if isinstance(value, list) else value

    @model_validator(mode="after")
    def _validate_browser_selection(self) -> "AccessConfig":
        if self.browser_enabled and self.browser_profile is None:
            raise ValueError("enabled Browser access requires a selected profile")
        groups = tuple(item.rate_limit_group for item in self.browser_policy_overrides)
        if len(groups) != len(set(groups)):
            raise ValueError("Browser policy overrides must have unique groups")
        return self


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


class BrowserProfileStatus(_FrozenModel):
    """Secret-free local presence of one selected operator-managed profile."""

    presence: BrowserProfilePresence


class ParsingConfigurationStatus(_FrozenModel):
    """Local completeness of the selected MinerU configuration."""

    configuration_complete: bool
    bearer_token_required: bool
    bearer_token_configured: bool | None = None
    credential_origin_matches: bool | None = None
    missing_fields: tuple[NonBlankText, ...] = ()

    @model_validator(mode="after")
    def _validate_secret_state(self) -> "ParsingConfigurationStatus":
        if self.bearer_token_required != (self.bearer_token_configured is not None):
            raise ValueError("parser secret status is inconsistent")
        if self.bearer_token_required != (self.credential_origin_matches is not None):
            raise ValueError("parser credential origin status is inconsistent")
        if self.configuration_complete == bool(self.missing_fields):
            raise ValueError("parser configuration completeness is inconsistent")
        return self


class AnalysisConfigurationStatus(_FrozenModel):
    """Local completeness of reference and full-content LLM configuration."""

    api_key_required: bool
    api_key_configured: bool | None = None
    credential_origin_matches: bool | None = None
    reference_configuration_complete: bool
    content_configuration_complete: bool
    reference_missing_fields: tuple[NonBlankText, ...] = ()
    content_missing_fields: tuple[NonBlankText, ...] = ()

    @model_validator(mode="after")
    def _validate_analysis_state(self) -> "AnalysisConfigurationStatus":
        if self.api_key_required != (self.api_key_configured is not None):
            raise ValueError("analysis secret status is inconsistent")
        if self.api_key_required != (self.credential_origin_matches is not None):
            raise ValueError("analysis credential origin status is inconsistent")
        if self.reference_configuration_complete == bool(self.reference_missing_fields):
            raise ValueError("reference analysis completeness is inconsistent")
        if self.content_configuration_complete == bool(self.content_missing_fields):
            raise ValueError("content analysis completeness is inconsistent")
        if self.content_configuration_complete and not self.reference_configuration_complete:
            raise ValueError("analysis completeness is inconsistent")
        return self


class ConfigurationRuntimeStatus(_FrozenModel):
    """Secret-free local readiness outside the Provider capability matrix."""

    storage_configuration_complete: bool
    storage_missing_fields: tuple[NonBlankText, ...] = ()
    parsing: ParsingConfigurationStatus
    analysis: AnalysisConfigurationStatus

    @model_validator(mode="after")
    def _validate_storage_state(self) -> "ConfigurationRuntimeStatus":
        if self.storage_configuration_complete == bool(self.storage_missing_fields):
            raise ValueError("storage configuration completeness is inconsistent")
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


class LLMConfigurationProbeDetails(_FrozenModel):
    """Stable disclosure of the minimal LLM probe's bounded side effects."""

    request_kind: Literal["minimal-schema"] = "minimal-schema"
    sends_user_literature: Literal[False] = False
    may_consume_quota: Literal[True] = True
    strict_response_parseable: bool | None = None
    model: NonBlankText | None = None
    protocol: AnalysisProtocolValue | None = None


class MinerUConfigurationProbeDetails(_FrozenModel):
    """Stable disclosure of the health-only MinerU probe contract."""

    request_kind: Literal["health-only"] = "health-only"
    uploaded_pdf: Literal[False] = False
    health: NonBlankText | None = None
    release: NonBlankText | None = None
    api_protocol: Annotated[int, Field(strict=True, ge=1)] | None = None
    profile: Literal["vlm-engine"] = "vlm-engine"


class CoreConfigurationProbeResult(_FrozenModel):
    """One non-persistent LLM or MinerU probe with explicit side effects."""

    service: CoreCredentialService
    outcome: ProbeOutcomeValue
    local_ready: bool
    failure_code: StableFailureCode | None = None
    details: LLMConfigurationProbeDetails | MinerUConfigurationProbeDetails
    persisted: Literal[False] = False

    @model_validator(mode="after")
    def _validate_core_probe_shape(self) -> "CoreConfigurationProbeResult":
        _validate_core_probe_details(self.service, self.details)
        if self.outcome is ProbeOutcome.SKIPPED:
            if self.local_ready or self.failure_code is None:
                raise ValueError("skipped core probe result is inconsistent")
            return self
        if not self.local_ready:
            raise ValueError("executed core probe result is inconsistent")
        if self.outcome is ProbeOutcome.PASSED:
            if self.failure_code is not None:
                raise ValueError("passed core probe result is inconsistent")
            _validate_passed_core_probe_details(self.details)
            return self
        if self.failure_code is None:
            raise ValueError("failed core probe result requires a failure code")
        return self


def _validate_core_probe_details(
    service: CoreCredentialService,
    details: LLMConfigurationProbeDetails | MinerUConfigurationProbeDetails,
) -> None:
    if service is CoreCredentialService.LLM:
        if not isinstance(details, LLMConfigurationProbeDetails):
            raise ValueError("core probe details do not match the service")
    elif not isinstance(details, MinerUConfigurationProbeDetails):
        raise ValueError("core probe details do not match the service")


def _validate_passed_core_probe_details(
    details: LLMConfigurationProbeDetails | MinerUConfigurationProbeDetails,
) -> None:
    if isinstance(details, LLMConfigurationProbeDetails):
        if details.strict_response_parseable is not True:
            raise ValueError("passed LLM probe result is inconsistent")
        return
    if details.health != "healthy" or details.release != "3.4.4" or details.api_protocol != 2:
        raise ValueError("passed MinerU probe result is inconsistent")


__all__ = (
    "AccessConfig",
    "AcquisitionProviderTuple",
    "AcquisitionSourcesConfig",
    "AnalysisConfig",
    "AnalysisAuthentication",
    "AnalysisProvider",
    "AnalysisProtocol",
    "AssetsConfig",
    "BrowserPolicyOverrideConfig",
    "BrowserProfileIdentity",
    "BrowserProfilePresence",
    "BrowserProfileStatus",
    "Configuration",
    "ConfigurationCapabilityStatus",
    "ConfigurationDiagnostic",
    "ConfigurationFingerprint",
    "ConfigurationProbeResult",
    "ConfigurationProbeSummary",
    "CoreConfigurationProbeResult",
    "ConfigurationRuntimeStatus",
    "ConfigurationStatus",
    "ContactEmail",
    "CoreCredentialService",
    "CrossrefAccessMode",
    "CrossrefMetadataConfig",
    "CredentialFieldSpec",
    "CredentialFieldStatus",
    "CredentialStatus",
    "DiscoveryConfig",
    "ExecutionConfig",
    "LibraryConfig",
    "LLMConfigurationProbeDetails",
    "MetadataProviderTuple",
    "MetadataSourcesConfig",
    "MinerUConfigurationProbeDetails",
    "OrdinaryProviderParameter",
    "ParsingConfig",
    "ParsingConfigurationStatus",
    "ParserConnectionMode",
    "PathsConfig",
    "ProviderCapability",
    "ProviderCredentialStatus",
    "ProviderName",
    "AnalysisConfigurationStatus",
    "ProbeOutcome",
    "SourcesConfig",
    "StableFailureCode",
    "UnpaywallAcquisitionConfig",
    "WebOfScienceMetadataConfig",
    "WebOfScienceProduct",
    "normalize_browser_profile_identity",
)
