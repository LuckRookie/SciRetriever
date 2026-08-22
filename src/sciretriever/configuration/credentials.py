"""Provider and core-service credential contracts and owner-only storage.

This file parses and atomically publishes the fixed
`~/.sciretriever/credentials.toml` file.  It exposes opaque lookup protocols;
secret values never enter configuration models or status payloads.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path
from types import MappingProxyType
from typing import Final, NoReturn, Protocol, SupportsIndex, runtime_checkable

from sciretriever.configuration.documents import (
    _parse_toml,
)
from sciretriever.configuration.errors import fail as _fail
from sciretriever.configuration.file_store import (
    _DIRECTORY_MODE,
    _lstat,
    _lstat_directory,
    _read_verified,
)
from sciretriever.configuration.filesystem import current_uid as _current_uid
from sciretriever.configuration.filesystem import mode as _mode
from sciretriever.configuration.filesystem import safe_path as _safe_path
from sciretriever.model.configuration import (
    AgentAuthentication,
    Configuration,
    ConfigurationDiagnostic,
    CoreCredentialService,
    CredentialFieldSpec,
    CredentialFieldStatus,
    CredentialStatus,
    ParserConnectionMode,
    ProviderCapability,
    ProviderCredentialStatus,
    ProviderName,
)
from sciretriever.network.policy import PolicyError, normalize_url_with_configured_port

_CREDENTIALS_DIRECTORY_NAME: Final[str] = ".sciretriever"
_CREDENTIALS_FILE_NAME: Final[str] = "credentials.toml"


class _CoreCredentialSpec:
    __slots__ = ("next_secret_field", "secret_field")

    def __init__(self, secret_field: str) -> None:
        self.secret_field = secret_field
        self.next_secret_field = f"next_{secret_field}"


_CORE_CREDENTIAL_SPECS: Final[dict[CoreCredentialService, _CoreCredentialSpec]] = {
    CoreCredentialService.AGENTS: _CoreCredentialSpec("api_key"),
    CoreCredentialService.MINERU: _CoreCredentialSpec("bearer_token"),
    # The reviewed free v146 installer intentionally refuses a Pro key.  We
    # still accept an origin-bound optional value so the interactive manager
    # can retain an operator's future entitlement without ever treating it as
    # evidence of a usable download or injecting it into normal operations.
    CoreCredentialService.CLOAKBROWSER: _CoreCredentialSpec("license_key"),
}
_CORE_ORIGIN_FIELD: Final[str] = "origin"
_CORE_NEXT_ORIGIN_FIELD: Final[str] = "next_origin"


class _CredentialSpec:
    __slots__ = ("fields", "unsupported")

    def __init__(
        self,
        fields: tuple[CredentialFieldSpec, ...],
        *,
        unsupported: bool = False,
    ) -> None:
        self.fields = fields
        self.unsupported = unsupported


# Capability is part of the credential contract.  A file section may contain
# the union of these capability-specific field names, while status/readiness
# must always select one exact ``(provider, capability)`` entry.
_CAPABILITY_MATRIX: Final[dict[ProviderName, tuple[ProviderCapability, ...]]] = {
    ProviderName.WEB_OF_SCIENCE: (ProviderCapability.METADATA,),
    ProviderName.CROSSREF: (ProviderCapability.METADATA, ProviderCapability.ACQUISITION),
    ProviderName.SEMANTIC_SCHOLAR: (ProviderCapability.METADATA, ProviderCapability.ACQUISITION),
    ProviderName.ARXIV: (ProviderCapability.METADATA, ProviderCapability.ACQUISITION),
    ProviderName.OPENALEX: (ProviderCapability.METADATA, ProviderCapability.ACQUISITION),
    ProviderName.EUROPE_PMC: (ProviderCapability.METADATA, ProviderCapability.ACQUISITION),
    ProviderName.ELSEVIER: (ProviderCapability.METADATA, ProviderCapability.ACQUISITION),
    ProviderName.SPRINGER: (ProviderCapability.METADATA, ProviderCapability.ACQUISITION),
    ProviderName.DATACITE: (ProviderCapability.METADATA, ProviderCapability.ACQUISITION),
    ProviderName.CORE: (ProviderCapability.METADATA, ProviderCapability.ACQUISITION),
    ProviderName.OPENCITATIONS: (ProviderCapability.METADATA,),
    ProviderName.UNPAYWALL: (ProviderCapability.ACQUISITION,),
    ProviderName.WILEY: (ProviderCapability.ACQUISITION,),
    ProviderName.SCI_HUB: (ProviderCapability.ACQUISITION,),
}

_CREDENTIAL_SPECS: Final[dict[tuple[ProviderName, ProviderCapability], _CredentialSpec]] = {
    (ProviderName.WEB_OF_SCIENCE, ProviderCapability.METADATA): _CredentialSpec(
        fields=(CredentialFieldSpec(name="api_key", required=True),),
    ),
    (ProviderName.SEMANTIC_SCHOLAR, ProviderCapability.METADATA): _CredentialSpec(
        fields=(CredentialFieldSpec(name="api_key", required=False),),
    ),
    (ProviderName.SEMANTIC_SCHOLAR, ProviderCapability.ACQUISITION): _CredentialSpec(
        fields=(CredentialFieldSpec(name="api_key", required=False),),
    ),
    (ProviderName.OPENALEX, ProviderCapability.METADATA): _CredentialSpec(
        fields=(CredentialFieldSpec(name="api_key", required=False),),
    ),
    (ProviderName.OPENALEX, ProviderCapability.ACQUISITION): _CredentialSpec(
        fields=(CredentialFieldSpec(name="api_key", required=False),),
    ),
    (ProviderName.ELSEVIER, ProviderCapability.METADATA): _CredentialSpec(
        fields=(
            CredentialFieldSpec(name="api_key", required=True),
            CredentialFieldSpec(name="institution_token", required=False),
        ),
    ),
    (ProviderName.ELSEVIER, ProviderCapability.ACQUISITION): _CredentialSpec(
        fields=(
            CredentialFieldSpec(name="api_key", required=True),
            CredentialFieldSpec(name="institution_token", required=False),
        ),
    ),
    (ProviderName.SPRINGER, ProviderCapability.METADATA): _CredentialSpec(
        fields=(CredentialFieldSpec(name="api_key", required=True),),
    ),
    # Full Text metric requiredness is not closed by the current notes; keep
    # this capability unsupported until its adapter contract is accepted.
    (ProviderName.SPRINGER, ProviderCapability.ACQUISITION): _CredentialSpec(
        fields=(
            CredentialFieldSpec(name="api_key", required=True),
            CredentialFieldSpec(name="api_metric", required=True),
        ),
        unsupported=True,
    ),
    (ProviderName.CORE, ProviderCapability.METADATA): _CredentialSpec(
        fields=(CredentialFieldSpec(name="api_key", required=False),),
    ),
    (ProviderName.CORE, ProviderCapability.ACQUISITION): _CredentialSpec(
        fields=(CredentialFieldSpec(name="api_key", required=True),),
    ),
    (ProviderName.OPENCITATIONS, ProviderCapability.METADATA): _CredentialSpec(
        fields=(CredentialFieldSpec(name="access_token", required=False),),
    ),
    (ProviderName.WILEY, ProviderCapability.ACQUISITION): _CredentialSpec(
        fields=(CredentialFieldSpec(name="tdm_api_token", required=True),),
    ),
}

_CREDENTIAL_PROVIDER_NAMES: Final[frozenset[ProviderName]] = frozenset(
    provider for provider, _capability in _CREDENTIAL_SPECS
)

_UNSUPPORTED_CREDENTIAL_PROVIDERS: Final[frozenset[ProviderName]] = frozenset(
    {ProviderName.SCI_HUB}
)

_ACCEPTED_CREDENTIAL_PROVIDERS: Final[frozenset[ProviderName]] = (
    _CREDENTIAL_PROVIDER_NAMES | _UNSUPPORTED_CREDENTIAL_PROVIDERS
)


@runtime_checkable
class CredentialLookup(Protocol):
    """Read-only, secret-opaque credential view for production assembly.

    The concrete bundle remains private to this module.  Consumers can ask
    only for one allowlisted field or for non-secret field/provider presence;
    they cannot enumerate, mutate, serialize, or retain the parsed mapping.
    """

    def get(
        self,
        provider: ProviderName | str,
        field: str,
        default: str | None = None,
    ) -> str | None: ...

    def field_names(self, provider: ProviderName | str) -> tuple[str, ...]: ...

    def has_provider(self, provider: ProviderName | str) -> bool: ...

    def core_field_names(self, service: CoreCredentialService | str) -> tuple[str, ...]: ...

    def has_core_service(self, service: CoreCredentialService | str) -> bool: ...

    def core_secret_for_origin(
        self,
        service: CoreCredentialService | str,
        origin: str,
    ) -> str | None: ...


@runtime_checkable
class RuntimeSecretLookup(Protocol):
    """Opaque, capability-selected Parser/Agents secrets for Bootstrap."""

    @property
    def mineru_bearer_token(self) -> str | None: ...

    @property
    def agents_api_key(self) -> str | None: ...


def credential_path(*, home: str | Path | None = None) -> Path:
    """Return the fixed credentials path.

    ``home`` is a controlled dependency-injection seam for offline tests.  A
    caller cannot pass an arbitrary credentials filename or directory; the
    ``.sciretriever/credentials.toml`` suffix is always selected here.
    """

    base = Path.home() if home is None else _safe_path(home)
    return base / _CREDENTIALS_DIRECTORY_NAME / _CREDENTIALS_FILE_NAME


def _provider_name(value: ProviderName | str) -> ProviderName:
    if isinstance(value, ProviderName):
        return value
    if type(value) is str:
        try:
            return ProviderName(value)
        except ValueError as error:
            del error
            _fail("credentials provider is unknown")
    _fail("credentials provider is unknown")


def _core_service_name(value: CoreCredentialService | str) -> CoreCredentialService:
    if isinstance(value, CoreCredentialService):
        return value
    if type(value) is str:
        try:
            return CoreCredentialService(value)
        except ValueError as error:
            del error
            _fail("credentials service is unknown")
    _fail("credentials service is unknown")


def _credential_specs(provider: ProviderName) -> tuple[CredentialFieldSpec, ...]:
    required_by_name: dict[str, bool] = {}
    for capability in _CAPABILITY_MATRIX.get(provider, ()):
        spec = _CREDENTIAL_SPECS.get((provider, capability))
        if spec is None:
            continue
        for field in spec.fields:
            required_by_name[field.name] = required_by_name.get(field.name, False) or field.required
    return tuple(
        CredentialFieldSpec(name=name, required=required)
        for name, required in required_by_name.items()
    )


def _configurable_credential_specs(provider: ProviderName) -> tuple[CredentialFieldSpec, ...]:
    required_by_name: dict[str, bool] = {}
    for capability in _CAPABILITY_MATRIX.get(provider, ()):
        spec = _CREDENTIAL_SPECS.get((provider, capability))
        if spec is None or spec.unsupported:
            continue
        for field in spec.fields:
            required_by_name[field.name] = required_by_name.get(field.name, False) or field.required
    return tuple(
        CredentialFieldSpec(name=name, required=required)
        for name, required in required_by_name.items()
    )


def credential_field_specs(provider: ProviderName | str) -> tuple[CredentialFieldSpec, ...]:
    """Return the fixed, secret-free field contract used by the config manager."""

    name = _provider_name(provider)
    if name in _UNSUPPORTED_CREDENTIAL_PROVIDERS:
        return ()
    return _configurable_credential_specs(name)


def configurable_credential_providers() -> tuple[ProviderName, ...]:
    """Return Providers with an accepted, non-empty credential contract."""

    return tuple(
        provider
        for provider in ProviderName
        if provider in _CREDENTIAL_PROVIDER_NAMES and _configurable_credential_specs(provider)
    )


def _provider_capabilities(provider: ProviderName) -> tuple[ProviderCapability, ...]:
    capabilities = _CAPABILITY_MATRIX.get(provider)
    if capabilities is None:
        _fail("provider is unsupported")
    return capabilities


def _credential_status(
    provider: ProviderName,
    capability: ProviderCapability | str,
    present_fields: tuple[str, ...],
    *,
    section_present: bool,
    production_supported: bool,
) -> ProviderCredentialStatus:
    try:
        cap = (
            capability
            if isinstance(capability, ProviderCapability)
            else ProviderCapability(capability)
        )
    except (TypeError, ValueError):
        _fail("capability is unsupported")
    if cap not in _provider_capabilities(provider):
        # A capability that is not part of the accepted matrix is not a
        # credential state.  In particular, do not turn it into not-required.
        _fail("capability is unsupported")
    spec = _CREDENTIAL_SPECS.get((provider, cap))
    if spec is None:
        return ProviderCredentialStatus(
            provider=provider,
            capability=cap,
            status=(
                CredentialStatus.NOT_REQUIRED
                if production_supported
                else CredentialStatus.UNSUPPORTED
            ),
        )
    present = frozenset(field for field in present_fields if type(field) is str)
    fields = tuple(
        CredentialFieldStatus(name=item.name, required=item.required, present=item.name in present)
        for item in spec.fields
    )
    if not production_supported or spec.unsupported:
        return ProviderCredentialStatus(
            provider=provider,
            capability=cap,
            status=CredentialStatus.UNSUPPORTED,
            fields=fields,
        )
    required = tuple(item for item in fields if item.required)
    optional = tuple(item for item in fields if not item.required)
    missing_required = tuple(item for item in required if not item.present)
    missing_optional = tuple(item for item in optional if not item.present)
    if missing_required:
        status = CredentialStatus.PARTIAL if section_present else CredentialStatus.MISSING
    elif missing_optional:
        status = CredentialStatus.OPTIONAL_MISSING
    else:
        status = CredentialStatus.CONFIGURED
    return ProviderCredentialStatus(
        provider=provider,
        capability=cap,
        status=status,
        fields=fields,
    )


def _supported_capabilities(
    values: tuple[ProviderCapability | str, ...]
    | list[ProviderCapability | str]
    | set[ProviderCapability | str],
) -> frozenset[ProviderCapability]:
    result: set[ProviderCapability] = set()
    for value in values:
        try:
            result.add(
                value if isinstance(value, ProviderCapability) else ProviderCapability(value)
            )
        except (TypeError, ValueError):
            _fail("capability is unsupported")
    return frozenset(result)


def _credential_value(value: object) -> str:
    if type(value) is not str:
        _fail("credentials value is invalid")
    candidate = value.strip()
    if not candidate or any(
        ord(character) < 32 or ord(character) == 127 for character in candidate
    ):
        _fail("credentials value is invalid")
    return candidate


def _canonical_credential_origin(value: object) -> str:
    candidate = _credential_value(value)
    try:
        normalized = normalize_url_with_configured_port(
            candidate,
            allowed_schemes=("https",),
        )
    except (PolicyError, TypeError, ValueError):
        _fail("credentials value is invalid")
    if normalized.query or normalized.path != "/" or normalized.url != normalized.origin.text + "/":
        _fail("credentials value is invalid")
    return normalized.origin.text


def _credential_section(
    provider_key: object,
    section: object,
) -> tuple[ProviderName, dict[str, str]]:
    if type(provider_key) is not str:
        _fail("credentials provider is unknown")
    provider = _provider_name(provider_key)
    if provider not in _ACCEPTED_CREDENTIAL_PROVIDERS:
        _fail("credentials provider is unknown")
    if not isinstance(section, dict):
        _fail("credentials value is invalid")
    if provider in _UNSUPPORTED_CREDENTIAL_PROVIDERS:
        # Recognised solely to make diagnostics unsupported; no guessed field
        # may be accepted.
        if section:
            _fail("credentials field is unknown")
        _fail("credentials provider is unsupported")
    expected = {spec.name for spec in _credential_specs(provider)}
    values: dict[str, str] = {}
    for field, value in section.items():
        if type(field) is not str or field not in expected:
            _fail("credentials field is unknown")
        values[field] = _credential_value(value)
    if not values:
        _fail("credentials value is invalid")
    return provider, values


def _core_credential_section(
    service: CoreCredentialService,
    section: object,
) -> dict[str, str]:
    if not isinstance(section, dict):
        _fail("credentials value is invalid")
    spec = _CORE_CREDENTIAL_SPECS[service]
    primary = {spec.secret_field, _CORE_ORIGIN_FIELD}
    transition = {spec.next_secret_field, _CORE_NEXT_ORIGIN_FIELD}
    expected = primary | transition
    values: dict[str, str] = {}
    for field, value in section.items():
        if type(field) is not str or field not in expected:
            _fail("credentials field is unknown")
        values[field] = _credential_value(value)
    keys = set(values)
    if keys != primary and keys != expected:
        _fail("credentials value is invalid")
    if values[_CORE_ORIGIN_FIELD] != _canonical_credential_origin(values[_CORE_ORIGIN_FIELD]):
        _fail("credentials value is invalid")
    if transition <= keys:
        if values[_CORE_NEXT_ORIGIN_FIELD] != _canonical_credential_origin(
            values[_CORE_NEXT_ORIGIN_FIELD]
        ):
            _fail("credentials value is invalid")
        if values[_CORE_NEXT_ORIGIN_FIELD] == values[_CORE_ORIGIN_FIELD]:
            _fail("credentials value is invalid")
    return values


def _credential_payload(
    raw: bytes,
) -> tuple[
    dict[ProviderName, dict[str, str]],
    dict[CoreCredentialService, dict[str, str]],
]:
    payload = _parse_toml(raw, credentials=True)
    parsed: dict[ProviderName, dict[str, str]] = {}
    core: dict[CoreCredentialService, dict[str, str]] = {}
    for section_key, section in payload.items():
        if type(section_key) is str and section_key in {
            item.value for item in CoreCredentialService
        }:
            service = _core_service_name(section_key)
            core[service] = _core_credential_section(service, section)
            continue
        provider, values = _credential_section(section_key, section)
        parsed[provider] = values
    return parsed, core


def _read_credentials(
    home: str | Path | None = None,
) -> tuple[
    dict[ProviderName, dict[str, str]],
    dict[CoreCredentialService, dict[str, str]],
    os.stat_result | None,
]:
    path = credential_path(home=home)
    directory = path.parent
    metadata = _lstat_directory(directory, missing_ok=True)
    if metadata is None:
        return {}, {}, None
    if metadata.st_uid != _current_uid() or _mode(metadata) != _DIRECTORY_MODE:
        _fail("credentials directory has unsafe ownership or permissions")
    named = _lstat(path, missing_ok=True, credentials=True)
    if named is None:
        return {}, {}, None
    raw, final_metadata = _read_verified(path, credentials=True, secure=True)
    providers, core = _credential_payload(raw)
    return providers, core, final_metadata


class _SecretFields:
    """Private immutable mapping used only inside one short-lived bundle."""

    __slots__ = ("_values",)

    def __init__(self, values: Mapping[str, str]) -> None:
        self._values = MappingProxyType(dict(values))

    def get(self, field: str, default: str | None = None) -> str | None:
        return self._values.get(field, default)

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._values))


class _CredentialBundle:
    """Private short-lived secret container with an opaque representation."""

    __slots__ = ("_core", "_values")

    def __init__(
        self,
        values: Mapping[ProviderName, Mapping[str, str]],
        core: Mapping[CoreCredentialService, Mapping[str, str]] | None = None,
    ) -> None:
        self._values = {provider: _SecretFields(fields) for provider, fields in values.items()}
        self._core = {service: _SecretFields(fields) for service, fields in (core or {}).items()}

    def __repr__(self) -> str:
        providers = tuple(sorted(item.value for item in self._values))
        services = tuple(sorted(item.value for item in self._core))
        return f"CredentialBundle(providers={providers!r}, services={services!r})"

    __str__ = __repr__

    def __reduce_ex__(self, _protocol: SupportsIndex) -> NoReturn:
        raise TypeError("secret container is not serializable")

    def get(
        self,
        provider: ProviderName | str,
        field: str,
        default: str | None = None,
    ) -> str | None:
        """Return a value for adapter injection; drop the bundle promptly."""

        name = _provider_name(provider)
        if type(field) is not str:
            return default
        fields = self._values.get(name)
        return default if fields is None else fields.get(field, default)

    def field_names(self, provider: ProviderName | str) -> tuple[str, ...]:
        """Return only field names for diagnostics."""

        fields = self._values.get(_provider_name(provider))
        return () if fields is None else fields.names()

    def has_provider(self, provider: ProviderName | str) -> bool:
        return _provider_name(provider) in self._values

    def core_field_names(self, service: CoreCredentialService | str) -> tuple[str, ...]:
        name = _core_service_name(service)
        fields = self._core.get(name)
        return () if fields is None else (_CORE_CREDENTIAL_SPECS[name].secret_field, "origin")

    def has_core_service(self, service: CoreCredentialService | str) -> bool:
        return _core_service_name(service) in self._core

    def core_secret_for_origin(
        self,
        service: CoreCredentialService | str,
        origin: str,
    ) -> str | None:
        name = _core_service_name(service)
        fields = self._core.get(name)
        if fields is None or type(origin) is not str:
            return None
        spec = _CORE_CREDENTIAL_SPECS[name]
        if fields.get(_CORE_ORIGIN_FIELD) == origin:
            return fields.get(spec.secret_field)
        if fields.get(_CORE_NEXT_ORIGIN_FIELD) == origin:
            return fields.get(spec.next_secret_field)
        return None


class _RuntimeSecrets:
    """Opaque selected Parser/Agents secrets for one production assembly."""

    __slots__ = ("_agents_api_key", "_mineru_bearer_token")

    def __init__(
        self,
        *,
        mineru_bearer_token: str | None,
        agents_api_key: str | None,
    ) -> None:
        self._mineru_bearer_token = mineru_bearer_token
        self._agents_api_key = agents_api_key

    def __repr__(self) -> str:
        return "<RuntimeSecrets>"

    __str__ = __repr__

    def __reduce_ex__(self, _protocol: SupportsIndex) -> NoReturn:
        raise TypeError("secret container is not serializable")

    @property
    def mineru_bearer_token(self) -> str | None:
        return self._mineru_bearer_token

    @property
    def agents_api_key(self) -> str | None:
        return self._agents_api_key


def _service_origin(base_url: str | None) -> str:
    if base_url is None:
        _fail("configuration value is invalid")
    try:
        normalized = normalize_url_with_configured_port(
            base_url,
            allowed_schemes=("https",),
        )
    except (PolicyError, TypeError, ValueError):
        _fail("configuration value is invalid")
    if normalized.query:
        _fail("configuration value is invalid")
    return normalized.origin.text


def configuration_service_origin(base_url: str) -> str:
    """Return the canonical HTTPS origin used for core-secret binding."""

    return _service_origin(base_url)


def _bound_core_secret(
    credentials: CredentialLookup,
    service: CoreCredentialService,
    secret_field: str,
    expected_origin: str,
) -> str:
    del secret_field
    secret = credentials.core_secret_for_origin(service, expected_origin)
    if secret is None:
        _fail("configuration value is invalid")
    return secret


def load_runtime_secrets(
    configuration: Configuration,
    *,
    credentials: CredentialLookup | None = None,
    credentials_home: str | Path | None = None,
    include_parser: bool = True,
    include_agents: bool = True,
) -> RuntimeSecretLookup:
    """Select origin-bound Parser/Agents secrets from credentials.toml."""

    if type(include_parser) is not bool or type(include_agents) is not bool:
        _fail("configuration value is invalid")
    if credentials is not None and credentials_home is not None:
        _fail("configuration value is invalid")
    if credentials is not None and not isinstance(credentials, CredentialLookup):
        _fail("configuration value is invalid")
    if not isinstance(configuration, Configuration):
        _fail("configuration value is invalid")
    parser = configuration.parsing
    agents = configuration.agents
    parser_needs_secret = include_parser and parser.connection_mode is ParserConnectionMode.REMOTE
    agents_needs_secret = include_agents and agents.authentication is AgentAuthentication.API_KEY
    bundle = (
        load_credentials(home=credentials_home)
        if credentials is None and (parser_needs_secret or agents_needs_secret)
        else credentials
    )
    if parser_needs_secret:
        assert bundle is not None
        mineru = _bound_core_secret(
            bundle,
            CoreCredentialService.MINERU,
            _CORE_CREDENTIAL_SPECS[CoreCredentialService.MINERU].secret_field,
            _service_origin(parser.base_url),
        )
    else:
        mineru = None
    if not include_agents:
        agents_key = None
    elif not agents_needs_secret:
        agents_key = None
    elif agents.authentication is AgentAuthentication.API_KEY:
        assert bundle is not None
        agents_key = _bound_core_secret(
            bundle,
            CoreCredentialService.AGENTS,
            _CORE_CREDENTIAL_SPECS[CoreCredentialService.AGENTS].secret_field,
            _service_origin(agents.base_url),
        )
    else:
        _fail("configuration value is invalid")
    return _RuntimeSecrets(
        mineru_bearer_token=mineru,
        agents_api_key=agents_key,
    )


def load_credentials(*, home: str | Path | None = None) -> CredentialLookup:
    """Load the fixed user-level credentials file through a safe descriptor."""

    values, core, _metadata = _read_credentials(home)
    # Copy the outer and inner containers so a caller cannot mutate parser
    # state retained by another operation.  Values remain private to this
    # short-lived object and never enter a Pydantic model.
    return _CredentialBundle(
        {provider: dict(fields) for provider, fields in values.items()},
        {service: dict(fields) for service, fields in core.items()},
    )


def credential_section_exists(
    provider: ProviderName | str,
    *,
    home: str | Path | None = None,
) -> bool:
    """Return only whether one supported secret-bearing section exists.

    This is the narrow CLI confirmation seam.  It intentionally reveals no
    field presence, value, length, mask, digest, or other secret
    characteristic.  Providers without an accepted credential section are
    rejected instead of being confused with an absent section.
    """

    name = _provider_name(provider)
    if name not in _CREDENTIAL_PROVIDER_NAMES or not _credential_specs(name):
        _fail("credentials provider is unsupported")
    values, _core, _metadata = _read_credentials(home)
    return name in values


def core_credential_section_exists(
    service: CoreCredentialService | str,
    *,
    home: str | Path | None = None,
) -> bool:
    """Return only whether one core-service secret section exists."""

    name = _core_service_name(service)
    _providers, core, _metadata = _read_credentials(home)
    return name in core


def credential_diagnostic(
    provider: ProviderName | str,
    *,
    credentials: CredentialLookup | None = None,
    home: str | Path | None = None,
    supported_capabilities: tuple[ProviderCapability | str, ...]
    | list[ProviderCapability | str]
    | set[ProviderCapability | str] = (),
) -> ConfigurationDiagnostic:
    """Return local status for all capabilities of one provider."""

    name = _provider_name(provider)
    bundle = load_credentials(home=home) if credentials is None else credentials
    present = bundle.field_names(name)
    supported = _supported_capabilities(supported_capabilities)
    if any(capability not in _provider_capabilities(name) for capability in supported):
        _fail("capability is unsupported")
    statuses = tuple(
        _credential_status(
            name,
            capability,
            present,
            section_present=bundle.has_provider(name),
            production_supported=capability in supported,
        )
        for capability in _provider_capabilities(name)
    )
    return ConfigurationDiagnostic(provider=name, capabilities=statuses)


def credential_status_for(
    provider: ProviderName | str,
    capability: ProviderCapability | str,
    *,
    credentials: CredentialLookup | None = None,
    home: str | Path | None = None,
    supported_capabilities: tuple[ProviderCapability | str, ...]
    | list[ProviderCapability | str]
    | set[ProviderCapability | str] = (),
) -> ProviderCredentialStatus:
    bundle = load_credentials(home=home) if credentials is None else credentials
    name = _provider_name(provider)
    supported = _supported_capabilities(supported_capabilities)
    if any(capability not in _provider_capabilities(name) for capability in supported):
        _fail("capability is unsupported")
    try:
        cap = (
            capability
            if isinstance(capability, ProviderCapability)
            else ProviderCapability(capability)
        )
    except (TypeError, ValueError):
        _fail("capability is unsupported")
    return _credential_status(
        name,
        cap,
        bundle.field_names(name),
        section_present=bundle.has_provider(name),
        production_supported=cap in supported,
    )


_READY_CREDENTIAL_STATUSES: Final[frozenset[CredentialStatus]] = frozenset(
    {
        CredentialStatus.NOT_REQUIRED,
        CredentialStatus.CONFIGURED,
        CredentialStatus.OPTIONAL_MISSING,
    }
)
