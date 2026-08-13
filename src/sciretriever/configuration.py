"""The single configuration and local-credentials boundary.

Only this module reads ordinary TOML, the configuration-path environment
variable, or ``~/.sciretriever/credentials.toml``.  The rest of the
application receives immutable, secret-free models from
``sciretriever.model.configuration``; provider adapters receive a private
short-lived :class:`CredentialBundle` only through their assembly boundary.

The implementation intentionally does not provide CLI presenters, network
probes, provider adapters, or an arbitrary credentials-file option.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
import tempfile
from pathlib import Path
from types import MappingProxyType
from typing import Callable, Final, Mapping, NoReturn, Protocol, SupportsIndex, runtime_checkable

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - Python 3.10 uses the locked tomli dependency.
    import tomli as tomllib

from pydantic import ValidationError

from sciretriever.model.configuration import (
    AccessConfig,
    AcquisitionSourcesConfig,
    AnalysisConfig,
    AssetsConfig,
    Configuration,
    ConfigurationCapabilityStatus,
    ConfigurationDiagnostic,
    ConfigurationProbeResult,
    ConfigurationProbeSummary,
    ConfigurationStatus,
    CredentialFieldSpec,
    CredentialFieldStatus,
    CredentialStatus,
    DiscoveryConfig,
    ExecutionConfig,
    LibraryConfig,
    ParsingConfig,
    PathsConfig,
    ProbeOutcome,
    ProviderCapability,
    ProviderCredentialStatus,
    ProviderName,
    SourcesConfig,
    UnpaywallAcquisitionConfig,
)

_MAX_CONFIGURATION_BYTES: Final[int] = 1_048_576
_MAX_CREDENTIALS_BYTES: Final[int] = 1_048_576
_CONFIGURATION_ENVIRONMENT: Final[str] = "SCIRETRIEVER_CONFIG"
_CREDENTIALS_DIRECTORY_NAME: Final[str] = ".sciretriever"
_CREDENTIALS_FILE_NAME: Final[str] = "credentials.toml"
_DIRECTORY_MODE: Final[int] = 0o700
_FILE_MODE: Final[int] = 0o600
_MINERU_TOKEN_ENVIRONMENT: Final[str] = "SCIRETRIEVER_MINERU_BEARER_TOKEN"
_OPENAI_KEY_ENVIRONMENT: Final[str] = "SCIRETRIEVER_OPENAI_API_KEY"
_ANTHROPIC_KEY_ENVIRONMENT: Final[str] = "SCIRETRIEVER_ANTHROPIC_API_KEY"


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
        fields=(CredentialFieldSpec(name="api_key", required=False),),
    ),
    (ProviderName.OPENCITATIONS, ProviderCapability.METADATA): _CredentialSpec(
        fields=(CredentialFieldSpec(name="access_token", required=False),),
    ),
    (ProviderName.WILEY, ProviderCapability.ACQUISITION): _CredentialSpec(
        fields=(),
        unsupported=True,
    ),
}

_CREDENTIAL_PROVIDER_NAMES: Final[frozenset[ProviderName]] = frozenset(
    provider for provider, _capability in _CREDENTIAL_SPECS
)

_UNSUPPORTED_CREDENTIAL_PROVIDERS: Final[frozenset[ProviderName]] = frozenset(
    {ProviderName.WILEY, ProviderName.SCI_HUB}
)

_ACCEPTED_CREDENTIAL_PROVIDERS: Final[frozenset[ProviderName]] = (
    _CREDENTIAL_PROVIDER_NAMES | _UNSUPPORTED_CREDENTIAL_PROVIDERS
)


class ConfigurationError(ValueError):
    """A stable, secret-free configuration boundary error."""

    def __init__(self, message: str = "configuration operation failed") -> None:
        # Callers must never be able to accidentally interpolate TOML values,
        # exception objects, or secret-bearing paths into this error.
        safe = message if message in _SAFE_MESSAGES else "configuration operation failed"
        super().__init__(safe)


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


@runtime_checkable
class RuntimeSecretLookup(Protocol):
    """Opaque, capability-selected Parser/Analysis secrets for Bootstrap."""

    @property
    def mineru_bearer_token(self) -> str | None: ...

    @property
    def analysis_api_key(self) -> str | None: ...


_SAFE_MESSAGES: frozenset[str] = frozenset(
    {
        "configuration operation failed",
        "configuration input is malformed",
        "configuration input is too large",
        "configuration section is unknown",
        "configuration key is unknown",
        "configuration value is invalid",
        "configuration file is unavailable",
        "configuration file changed during read",
        "configuration file is not a regular file",
        "configuration file is a symbolic link",
        "configuration file has unsafe ownership or permissions",
        "configuration directory is unavailable",
        "configuration directory is not a regular directory",
        "configuration directory is a symbolic link",
        "configuration directory has unsafe ownership or permissions",
        "credentials provider is unknown",
        "credentials field is unknown",
        "credentials provider is unsupported",
        "credentials value is invalid",
        "credentials file is unavailable",
        "credentials file changed during read",
        "credentials file is not a regular file",
        "credentials file is a symbolic link",
        "credentials file has unsafe ownership or permissions",
        "credentials directory is unavailable",
        "credentials directory is not a regular directory",
        "credentials directory is a symbolic link",
        "credentials directory has unsafe ownership or permissions",
        "credentials publication failed",
        "credentials publication was interrupted",
        "provider is unsupported",
        "capability is unsupported",
    }
)


def _fail(message: str) -> NoReturn:
    raise ConfigurationError(message)


def _safe_path(value: str | Path) -> Path:
    if isinstance(value, Path):
        return value
    if type(value) is str:
        return Path(value).expanduser()
    _fail("configuration value is invalid")


def _current_uid() -> int:
    # ``geteuid`` is the identity used for access checks on POSIX.  The
    # fallback keeps the module importable on platforms without it.
    getter = getattr(os, "geteuid", os.getuid)
    return getter()


def _mode(metadata: os.stat_result) -> int:
    return stat.S_IMODE(metadata.st_mode)


def _same_identity(first: os.stat_result, second: os.stat_result) -> bool:
    return os.path.samestat(first, second)


def _same_metadata(first: os.stat_result, second: os.stat_result) -> bool:
    return (
        first.st_dev == second.st_dev
        and first.st_ino == second.st_ino
        and stat.S_IFMT(first.st_mode) == stat.S_IFMT(second.st_mode)
        and first.st_size == second.st_size
        and first.st_mtime_ns == second.st_mtime_ns
        and first.st_ctime_ns == second.st_ctime_ns
        and first.st_nlink == second.st_nlink
    )


def _lstat(path: Path, *, missing_ok: bool, credentials: bool) -> os.stat_result | None:
    try:
        value = os.lstat(path)
    except FileNotFoundError:
        if missing_ok:
            return None
        _fail(
            "credentials file is unavailable"
            if credentials
            else "configuration file is unavailable"
        )
    except OSError:
        _fail(
            "credentials file is unavailable"
            if credentials
            else "configuration file is unavailable"
        )
    if stat.S_ISLNK(value.st_mode):
        _fail(
            "credentials file is a symbolic link"
            if credentials
            else "configuration file is a symbolic link"
        )
    return value


def _validate_regular_file(
    metadata: os.stat_result,
    *,
    credentials: bool,
    secure: bool,
) -> None:
    if not stat.S_ISREG(metadata.st_mode):
        _fail(
            "credentials file is not a regular file"
            if credentials
            else "configuration file is not a regular file"
        )
    limit = _MAX_CREDENTIALS_BYTES if credentials else _MAX_CONFIGURATION_BYTES
    if metadata.st_size > limit:
        _fail("configuration input is too large")
    if secure and (
        metadata.st_uid != _current_uid() or _mode(metadata) != _FILE_MODE or metadata.st_nlink != 1
    ):
        _fail("credentials file has unsafe ownership or permissions")


def _open_verified(path: Path, *, credentials: bool, secure: bool) -> tuple[int, os.stat_result]:
    flags = os.O_RDONLY
    for name in ("O_CLOEXEC", "O_NOFOLLOW", "O_BINARY"):
        value = getattr(os, name, 0)
        if isinstance(value, int):
            flags |= value
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        _fail(
            "credentials file is unavailable"
            if credentials
            else "configuration file is unavailable"
        )
    except OSError:
        _fail(
            "credentials file is unavailable"
            if credentials
            else "configuration file is unavailable"
        )
    try:
        metadata = os.fstat(descriptor)
        _validate_regular_file(metadata, credentials=credentials, secure=secure)
        named = _lstat(path, missing_ok=False, credentials=credentials)
        if named is None or not _same_identity(named, metadata):
            _fail(
                "credentials file changed during read"
                if credentials
                else "configuration file changed during read"
            )
        return descriptor, metadata
    except BaseException:
        os.close(descriptor)
        raise


def _read_bounded(descriptor: int, *, credentials: bool) -> bytes:
    limit = _MAX_CREDENTIALS_BYTES if credentials else _MAX_CONFIGURATION_BYTES
    result = bytearray()
    while len(result) <= limit:
        remaining = limit + 1 - len(result)
        try:
            chunk = os.read(descriptor, min(65_536, remaining))
        except OSError:
            _fail(
                "credentials file is unavailable"
                if credentials
                else "configuration file is unavailable"
            )
        if not chunk:
            break
        result.extend(chunk)
    if len(result) > limit:
        _fail("configuration input is too large")
    return bytes(result)


def _read_verified(path: Path, *, credentials: bool, secure: bool) -> tuple[bytes, os.stat_result]:
    """Read through one descriptor and detect path/content replacement races."""

    named_before = _lstat(path, missing_ok=False, credentials=credentials)
    if named_before is None:  # pragma: no cover - guarded by ``missing_ok``.
        _fail(
            "credentials file is unavailable"
            if credentials
            else "configuration file is unavailable"
        )
    descriptor, descriptor_before = _open_verified(path, credentials=credentials, secure=secure)
    try:
        # Re-check the name immediately after open, before any bytes are read.
        named_after_open = _lstat(path, missing_ok=False, credentials=credentials)
        if named_after_open is None or not _same_identity(named_after_open, descriptor_before):
            _fail(
                "credentials file changed during read"
                if credentials
                else "configuration file changed during read"
            )
        payload = _read_bounded(descriptor, credentials=credentials)
        try:
            descriptor_after = os.fstat(descriptor)
        except OSError:
            _fail(
                "credentials file changed during read"
                if credentials
                else "configuration file changed during read"
            )
        named_after = _lstat(path, missing_ok=False, credentials=credentials)
        if named_after is None or not _same_identity(named_after, descriptor_after):
            _fail(
                "credentials file changed during read"
                if credentials
                else "configuration file changed during read"
            )
        _validate_regular_file(descriptor_after, credentials=credentials, secure=secure)
        if (
            not _same_metadata(descriptor_before, descriptor_after)
            or len(payload) != descriptor_after.st_size
        ):
            _fail(
                "credentials file changed during read"
                if credentials
                else "configuration file changed during read"
            )
        return payload, descriptor_after
    finally:
        os.close(descriptor)


def _secure_directory(path: Path, *, create: bool) -> Path:
    metadata = _lstat_directory(path, missing_ok=True)
    if metadata is None and not create:
        _fail("credentials directory is unavailable")
    if metadata is None:
        try:
            path.mkdir(mode=_DIRECTORY_MODE, parents=False, exist_ok=False)
        except FileExistsError:
            metadata = _lstat_directory(path, missing_ok=False)
        except OSError:
            _fail("credentials directory is unavailable")
        else:
            metadata = _lstat_directory(path, missing_ok=False)
    if metadata is None:  # pragma: no cover - defensive.
        _fail("credentials directory is unavailable")
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        _fail("credentials directory is not a regular directory")
    if metadata.st_uid != _current_uid() or _mode(metadata) != _DIRECTORY_MODE:
        _fail("credentials directory has unsafe ownership or permissions")
    return path


def _lstat_directory(path: Path, *, missing_ok: bool) -> os.stat_result | None:
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        if missing_ok:
            return None
        _fail("credentials directory is unavailable")
    except OSError:
        _fail("credentials directory is unavailable")
    if stat.S_ISLNK(metadata.st_mode):
        _fail("credentials directory is a symbolic link")
    if not stat.S_ISDIR(metadata.st_mode):
        _fail("credentials directory is not a regular directory")
    return metadata


def credential_path(*, home: str | Path | None = None) -> Path:
    """Return the fixed credentials path.

    ``home`` is a controlled dependency-injection seam for offline tests.  A
    caller cannot pass an arbitrary credentials filename or directory; the
    ``.sciretriever/credentials.toml`` suffix is always selected here.
    """

    base = Path.home() if home is None else _safe_path(home)
    return base / _CREDENTIALS_DIRECTORY_NAME / _CREDENTIALS_FILE_NAME


def _empty_configuration() -> Configuration:
    return Configuration(
        paths=PathsConfig(),
        discovery=DiscoveryConfig(),
        sources=SourcesConfig(),
        assets=AssetsConfig(),
        parsing=ParsingConfig(),
        analysis=AnalysisConfig(),
        execution=ExecutionConfig(),
        library=LibraryConfig(),
        access=AccessConfig(),
    )


def _parse_toml(raw: bytes, *, credentials: bool) -> dict[str, object]:
    if len(raw) > (_MAX_CREDENTIALS_BYTES if credentials else _MAX_CONFIGURATION_BYTES):
        _fail("configuration input is too large")
    try:
        text = raw.decode("utf-8")
        value = tomllib.loads(text)
    except (UnicodeDecodeError, tomllib.TOMLDecodeError):
        _fail("configuration input is malformed")
    if not isinstance(value, dict):  # pragma: no cover - tomllib always returns a dict.
        _fail("configuration input is malformed")
    return value


_CONFIGURATION_SECTIONS: Final[frozenset[str]] = frozenset(
    {
        "paths",
        "discovery",
        "sources",
        "assets",
        "parsing",
        "analysis",
        "execution",
        "library",
        "access",
    }
)


def _parse_configuration_payload(raw: bytes) -> Configuration:
    payload = _parse_toml(raw, credentials=False)
    if set(payload) - _CONFIGURATION_SECTIONS:
        _fail("configuration section is unknown")
    try:
        value = Configuration.model_validate(payload)
    except ValidationError as error:
        # ``hide_input_in_errors`` on all models means the originating value is
        # not rendered, but use a stable boundary error nevertheless.
        del error
        _fail("configuration value is invalid")
    return value


def parse_configuration(payload: str | bytes) -> Configuration:
    """Parse ordinary configuration text without reading files or secrets."""

    raw = payload.encode("utf-8") if isinstance(payload, str) else payload
    if not isinstance(raw, bytes):
        _fail("configuration value is invalid")
    return _parse_configuration_payload(raw)


def load_configuration(path: str | Path) -> Configuration:
    """Load one ordinary TOML file through a bounded descriptor read."""

    selected = _safe_path(path)
    raw, _metadata = _read_verified(selected, credentials=False, secure=False)
    return _parse_configuration_payload(raw)


def select_configuration_path(
    explicit: str | Path | None = None,
    *,
    environment: Mapping[str, str] | None = None,
    cwd: str | Path | None = None,
) -> Path:
    """Select an ordinary config file; this never selects credentials."""

    if explicit is not None:
        return _safe_path(explicit)
    values = os.environ if environment is None else environment
    selected = values.get(_CONFIGURATION_ENVIRONMENT)
    if selected:
        return _safe_path(selected)
    local = (Path.cwd() if cwd is None else _safe_path(cwd)) / "config.toml"
    try:
        if local.is_file():
            return local
    except OSError:
        _fail("configuration file is unavailable")
    _fail("configuration file is unavailable")


def load_selected_configuration(
    explicit: str | Path | None = None,
    *,
    environment: Mapping[str, str] | None = None,
    cwd: str | Path | None = None,
) -> Configuration:
    return load_configuration(select_configuration_path(explicit, environment=environment, cwd=cwd))


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


def _credential_specs(provider: ProviderName) -> tuple[CredentialFieldSpec, ...]:
    names: list[str] = []
    result: list[CredentialFieldSpec] = []
    for capability in _CAPABILITY_MATRIX.get(provider, ()):
        spec = _CREDENTIAL_SPECS.get((provider, capability))
        if spec is None:
            continue
        for field in spec.fields:
            if field.name not in names:
                names.append(field.name)
                result.append(field)
    return tuple(result)


def credential_field_specs(provider: ProviderName | str) -> tuple[CredentialFieldSpec, ...]:
    """Return the fixed, secret-free field contract used by ``config set``."""

    name = _provider_name(provider)
    if name in _UNSUPPORTED_CREDENTIAL_PROVIDERS:
        return ()
    return _credential_specs(name)


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
    if not production_supported:
        return ProviderCredentialStatus(
            provider=provider,
            capability=cap,
            status=CredentialStatus.UNSUPPORTED,
        )
    spec = _CREDENTIAL_SPECS.get((provider, cap))
    if spec is None:
        return ProviderCredentialStatus(
            provider=provider,
            capability=cap,
            status=CredentialStatus.NOT_REQUIRED,
        )
    if spec.unsupported:
        return ProviderCredentialStatus(
            provider=provider,
            capability=cap,
            status=CredentialStatus.UNSUPPORTED,
        )
    present = frozenset(field for field in present_fields if type(field) is str)
    fields = tuple(
        CredentialFieldStatus(name=item.name, required=item.required, present=item.name in present)
        for item in spec.fields
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


def _credential_payload(raw: bytes) -> dict[ProviderName, dict[str, str]]:
    payload = _parse_toml(raw, credentials=True)
    parsed: dict[ProviderName, dict[str, str]] = {}
    for provider_key, section in payload.items():
        provider, values = _credential_section(provider_key, section)
        parsed[provider] = values
    return parsed


def _read_credentials(
    home: str | Path | None = None,
) -> tuple[dict[ProviderName, dict[str, str]], os.stat_result | None]:
    path = credential_path(home=home)
    directory = path.parent
    metadata = _lstat_directory(directory, missing_ok=True)
    if metadata is None:
        return {}, None
    if metadata.st_uid != _current_uid() or _mode(metadata) != _DIRECTORY_MODE:
        _fail("credentials directory has unsafe ownership or permissions")
    named = _lstat(path, missing_ok=True, credentials=True)
    if named is None:
        return {}, None
    raw, final_metadata = _read_verified(path, credentials=True, secure=True)
    return _credential_payload(raw), final_metadata


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

    __slots__ = ("_values",)

    def __init__(self, values: Mapping[ProviderName, Mapping[str, str]]) -> None:
        self._values = {provider: _SecretFields(fields) for provider, fields in values.items()}

    def __repr__(self) -> str:
        providers = tuple(sorted(item.value for item in self._values))
        return f"CredentialBundle(providers={providers!r})"

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


class _RuntimeSecrets:
    """Opaque selected Parser/Analysis secrets for one production assembly."""

    __slots__ = ("_analysis_api_key", "_mineru_bearer_token")

    def __init__(
        self,
        *,
        mineru_bearer_token: str | None,
        analysis_api_key: str | None,
    ) -> None:
        self._mineru_bearer_token = mineru_bearer_token
        self._analysis_api_key = analysis_api_key

    def __repr__(self) -> str:
        return "<RuntimeSecrets>"

    __str__ = __repr__

    def __reduce_ex__(self, _protocol: SupportsIndex) -> NoReturn:
        raise TypeError("secret container is not serializable")

    @property
    def mineru_bearer_token(self) -> str | None:
        return self._mineru_bearer_token

    @property
    def analysis_api_key(self) -> str | None:
        return self._analysis_api_key


def _selected_secret(values: Mapping[str, str], name: str) -> str:
    value = values.get(name)
    if type(value) is not str:
        _fail("configuration value is invalid")
    candidate = value.strip()
    if not candidate or any(
        ord(character) < 32 or ord(character) == 127 for character in candidate
    ):
        _fail("configuration value is invalid")
    return candidate


def load_runtime_secrets(
    configuration: Configuration,
    *,
    environment: Mapping[str, str] | None = None,
    include_parser: bool = True,
    include_analysis: bool = True,
) -> RuntimeSecretLookup:
    """Read only fixed environment fields selected by ordinary configuration."""

    from sciretriever.model.configuration import AnalysisProvider, ParserConnectionMode

    values = os.environ if environment is None else environment
    if type(include_parser) is not bool or type(include_analysis) is not bool:
        _fail("configuration value is invalid")
    parser = configuration.parsing
    analysis = configuration.analysis
    if include_parser and parser.connection_mode is ParserConnectionMode.REMOTE:
        mineru = _selected_secret(values, _MINERU_TOKEN_ENVIRONMENT)
    else:
        mineru = None
    if not include_analysis:
        analysis_key = None
    elif analysis.provider is AnalysisProvider.OPENAI:
        analysis_key = _selected_secret(values, _OPENAI_KEY_ENVIRONMENT)
    elif analysis.provider is AnalysisProvider.ANTHROPIC:
        analysis_key = _selected_secret(values, _ANTHROPIC_KEY_ENVIRONMENT)
    else:
        _fail("configuration value is invalid")
    return _RuntimeSecrets(
        mineru_bearer_token=mineru,
        analysis_api_key=analysis_key,
    )


def load_credentials(*, home: str | Path | None = None) -> CredentialLookup:
    """Load the fixed user-level credentials file through a safe descriptor."""

    values, _metadata = _read_credentials(home)
    # Copy the outer and inner containers so a caller cannot mutate parser
    # state retained by another operation.  Values remain private to this
    # short-lived object and never enter a Pydantic model.
    return _CredentialBundle({provider: dict(fields) for provider, fields in values.items()})


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
    values, _metadata = _read_credentials(home)
    return name in values


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


def _metadata_configuration_statuses(
    configuration: Configuration,
    credentials: CredentialLookup,
) -> dict[ProviderName, ConfigurationCapabilityStatus]:
    from sciretriever.metadata.registry import metadata_provider_statuses

    result: dict[ProviderName, ConfigurationCapabilityStatus] = {}
    for status in metadata_provider_statuses(configuration, credentials):
        provider = ProviderName(status.provider_name)
        production = status.production_available
        ordinary = status.failure_code != "missing-ordinary-parameter"
        credential = _credential_status(
            provider,
            ProviderCapability.METADATA,
            credentials.field_names(provider),
            section_present=credentials.has_provider(provider),
            production_supported=production,
        )
        policy = status.access_policy is not None and status.access_scope is not None
        result[provider] = ConfigurationCapabilityStatus(
            provider=provider,
            capability=ProviderCapability.METADATA,
            production_available=production,
            enabled=status.enabled,
            ordinary_parameters_ready=ordinary,
            credential=credential,
            access_policy_ready=policy,
            probe_available=True,
            local_ready=status.ready,
            failure_code=status.failure_code,
        )
    return result


def _acquisition_configuration_statuses(
    configuration: Configuration,
    credentials: CredentialLookup,
    *,
    configured_sci_hub_resolver: object | None,
) -> dict[ProviderName, ConfigurationCapabilityStatus]:
    from sciretriever.acquisition.registry import acquisition_provider_statuses

    result: dict[ProviderName, ConfigurationCapabilityStatus] = {}
    statuses = acquisition_provider_statuses(
        configuration,
        configured_sci_hub_resolver=configured_sci_hub_resolver,  # type: ignore[arg-type]
    )
    for status in statuses:
        provider = ProviderName(status.provider_name)
        # Registry readiness answers whether normal Acquisition can consume
        # this Provider's evidence.  A generic AssetHint route is deliberately
        # not a Provider service adapter and must never become a config-test
        # probe registration.  No Acquisition Source currently has a
        # literature-independent, officially specified minimal probe.
        production = any(mapping.production_available for mapping in status.mappings)
        ordinary = status.failure_code != "missing-ordinary-parameter"
        # The current executable route is generic/public/operator-owned and
        # consumes no Provider credential.  Unsupported authorized/browser
        # mappings remain visible in the Acquisition registry, but their
        # future credential contract must not make a working public route
        # appear authenticated or missing credentials.
        credential = ProviderCredentialStatus(
            provider=provider,
            capability=ProviderCapability.ACQUISITION,
            status=(CredentialStatus.NOT_REQUIRED if production else CredentialStatus.UNSUPPORTED),
        )
        policy = production
        result[provider] = ConfigurationCapabilityStatus(
            provider=provider,
            capability=ProviderCapability.ACQUISITION,
            production_available=production,
            enabled=status.enabled,
            ordinary_parameters_ready=ordinary,
            credential=credential,
            access_policy_ready=policy,
            probe_available=False,
            local_ready=status.ready,
            failure_code=status.failure_code,
        )
    return result


def _configuration_fingerprint(configuration: Configuration) -> str:
    """Bind a status snapshot to ordinary settings without retaining paths.

    Ordinary configuration is already secret-free.  Catalog and artifact
    path strings are additionally reduced to presence bits before hashing so
    the diagnostic snapshot cannot become a path fingerprint.  The remaining
    canonical payload includes every ordinary group, including enabled
    Provider order and probe-relevant product parameters.
    """

    payload: dict[str, object] = configuration.model_dump(mode="json", by_alias=True)
    paths = payload.get("paths")
    if not isinstance(paths, dict):
        _fail("configuration value is invalid")
    payload["paths"] = {
        "catalog_path_configured": paths.get("catalog_path") is not None,
        "artifact_root_configured": paths.get("artifact_root") is not None,
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def configuration_status(
    configuration: Configuration,
    *,
    credentials: CredentialLookup | None = None,
    credentials_home: str | Path | None = None,
    configured_sci_hub_resolver: object | None = None,
) -> ConfigurationStatus:
    """Compute the full local matrix without Network, Catalog, or artifacts."""

    if not isinstance(configuration, Configuration):
        _fail("configuration value is invalid")
    if credentials is not None and credentials_home is not None:
        _fail("configuration value is invalid")
    if credentials is not None and not isinstance(credentials, CredentialLookup):
        _fail("configuration value is invalid")
    bundle = load_credentials(home=credentials_home) if credentials is None else credentials
    metadata = _metadata_configuration_statuses(configuration, bundle)
    acquisition = _acquisition_configuration_statuses(
        configuration,
        bundle,
        configured_sci_hub_resolver=configured_sci_hub_resolver,
    )
    capabilities: list[ConfigurationCapabilityStatus] = []
    for provider, accepted in _CAPABILITY_MATRIX.items():
        for capability in accepted:
            if capability is ProviderCapability.METADATA:
                capabilities.append(metadata[provider])
            else:
                capabilities.append(acquisition[provider])
    return ConfigurationStatus(
        configuration_fingerprint=_configuration_fingerprint(configuration),
        capabilities=tuple(capabilities),
    )


@runtime_checkable
class ConfigurationProbePort(Protocol):
    """Explicit Provider probe seam; implementations own all Network details."""

    @property
    def supported_capabilities(
        self,
    ) -> frozenset[tuple[ProviderName, ProviderCapability]]: ...

    def probe(
        self,
        provider: ProviderName,
        capability: ProviderCapability,
    ) -> ConfigurationProbeResult: ...


def _skipped_probe(status: ConfigurationCapabilityStatus) -> ConfigurationProbeResult:
    return ConfigurationProbeResult(
        provider=status.provider,
        capability=status.capability,
        outcome=ProbeOutcome.SKIPPED,
        local_ready=False,
        failure_code=status.failure_code or "local-readiness-failed",
    )


def _failed_probe(status: ConfigurationCapabilityStatus) -> ConfigurationProbeResult:
    return ConfigurationProbeResult(
        provider=status.provider,
        capability=status.capability,
        outcome=ProbeOutcome.FAILED,
        local_ready=True,
        network_reachable=False,
        failure_code="probe-failed",
    )


def _checked_probe_result(
    status: ConfigurationCapabilityStatus,
    result: object,
) -> ConfigurationProbeResult:
    if not isinstance(result, ConfigurationProbeResult):
        return _failed_probe(status)
    try:
        checked = ConfigurationProbeResult.model_validate(result.model_dump(mode="python"))
    except Exception:
        return _failed_probe(status)
    if (
        checked.provider is not status.provider
        or checked.capability is not status.capability
        or not checked.local_ready
        or checked.outcome is ProbeOutcome.SKIPPED
    ):
        return _failed_probe(status)
    return checked


def _validated_status_snapshot(
    configuration: Configuration,
    snapshot: ConfigurationStatus,
) -> ConfigurationStatus:
    """Revalidate one complete snapshot and bind enablement to configuration."""

    try:
        checked = ConfigurationStatus.model_validate(snapshot.model_dump(mode="python"))
    except Exception:
        _fail("configuration value is invalid")
    if checked.configuration_fingerprint != _configuration_fingerprint(configuration):
        _fail("configuration value is invalid")
    metadata_enabled = frozenset(configuration.sources.metadata.providers)
    acquisition_enabled = frozenset(configuration.sources.acquisition.providers)
    for status in checked.capabilities:
        enabled = (
            status.provider in metadata_enabled
            if status.capability is ProviderCapability.METADATA
            else status.provider in acquisition_enabled
        )
        probe_available = status.capability is ProviderCapability.METADATA
        if status.enabled is not enabled or status.probe_available is not probe_available:
            _fail("configuration value is invalid")
    return checked


def run_configuration_probes(
    configuration: Configuration,
    probe_port: ConfigurationProbePort,
    *,
    provider: ProviderName | str | None = None,
    test_all: bool = False,
    credentials_home: str | Path | None = None,
    configured_sci_hub_resolver: object | None = None,
    status_snapshot: ConfigurationStatus | None = None,
) -> ConfigurationProbeSummary:
    """Run an ordered, non-persistent explicit probe selection.

    A named Provider is tested even when disabled.  ``test_all`` considers
    only enabled production capabilities.  Local failures are represented as
    skipped results and one failed probe never short-circuits later entries.
    """

    if not isinstance(probe_port, ConfigurationProbePort):
        raise TypeError("probe_port must implement ConfigurationProbePort")
    if type(test_all) is not bool or (provider is None) == (not test_all):
        _fail("configuration value is invalid")
    selected_provider = None if provider is None else _provider_name(provider)
    supported = probe_port.supported_capabilities
    if not isinstance(supported, frozenset) or any(
        not isinstance(item, tuple)
        or len(item) != 2
        or not isinstance(item[0], ProviderName)
        or not isinstance(item[1], ProviderCapability)
        for item in supported
    ):
        raise TypeError("probe_port supported_capabilities is invalid")
    if status_snapshot is not None and (
        credentials_home is not None or configured_sci_hub_resolver is not None
    ):
        _fail("configuration value is invalid")
    if status_snapshot is not None and not isinstance(status_snapshot, ConfigurationStatus):
        _fail("configuration value is invalid")
    local = (
        configuration_status(
            configuration,
            credentials_home=credentials_home,
            configured_sci_hub_resolver=configured_sci_hub_resolver,
        )
        if status_snapshot is None
        else _validated_status_snapshot(configuration, status_snapshot)
    )
    selected = tuple(
        status
        for status in local.capabilities
        if status.probe_available
        and (status.provider, status.capability) in supported
        and (
            (test_all and status.enabled)
            or (selected_provider is not None and status.provider is selected_provider)
        )
    )
    results: list[ConfigurationProbeResult] = []
    for status in selected:
        if not status.local_ready:
            results.append(_skipped_probe(status))
            continue
        try:
            raw = probe_port.probe(status.provider, status.capability)
        except Exception:
            results.append(_failed_probe(status))
        else:
            results.append(_checked_probe_result(status, raw))
    return ConfigurationProbeSummary(results=tuple(results))


def _toml_quote(value: str) -> str:
    # JSON's basic-string escaping is a subset of TOML's basic-string syntax.
    return json.dumps(value, ensure_ascii=False)


def _render_credentials(values: Mapping[ProviderName, Mapping[str, str]]) -> bytes:
    lines: list[str] = []
    for provider in sorted(values, key=lambda item: item.value):
        section = values[provider]
        if not section:
            continue
        lines.append(f"[{provider.value}]\n")
        for field in sorted(section):
            value = section[field]
            lines.append(f"{field} = {_toml_quote(value)}\n")
        lines.append("\n")
    return "".join(lines).encode("utf-8")


def _write_all(descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        try:
            written = os.write(descriptor, payload[offset:])
        except OSError:
            _fail("credentials publication failed")
        if written <= 0:
            _fail("credentials publication failed")
        offset += written


def _call_failpoint(failpoint: Callable[[str], None] | None, name: str) -> None:
    if failpoint is None:
        return
    try:
        failpoint(name)
    except ConfigurationError:
        raise
    except BaseException:
        _fail("credentials publication was interrupted")


def _call_post_commit_observer(
    failpoint: Callable[[str], None] | None,
    name: str,
) -> None:
    """Notify a post-commit seam without turning it into a publication failure."""

    try:
        _call_failpoint(failpoint, name)
    except BaseException:
        # ``os.replace`` is the commit point.  Fault injection and cleanup
        # diagnostics after it cannot report failure because the new bytes
        # are already visible to readers.
        pass


def _directory_fd(path: Path) -> int:
    flags = os.O_RDONLY
    for name in ("O_CLOEXEC", "O_DIRECTORY", "O_BINARY"):
        value = getattr(os, name, 0)
        if isinstance(value, int):
            flags |= value
    try:
        return os.open(path, flags)
    except OSError:
        _fail("credentials publication failed")


def _write_and_sync_staging(
    descriptor: int,
    payload: bytes,
    failpoint: Callable[[str], None] | None,
) -> None:
    try:
        os.fchmod(descriptor, _FILE_MODE)
    except OSError:
        _fail("credentials publication failed")
    _call_failpoint(failpoint, "staging-created")
    _write_all(descriptor, payload)
    _call_failpoint(failpoint, "staging-written")
    try:
        os.fsync(descriptor)
    except OSError:
        _fail("credentials publication failed")
    _call_failpoint(failpoint, "staging-fsynced")


def _stage_credentials(
    directory: Path,
    payload: bytes,
    failpoint: Callable[[str], None] | None,
) -> Path:
    descriptor: int | None = None
    staging_path: Path | None = None
    try:
        try:
            descriptor, raw_path = tempfile.mkstemp(
                prefix=".credentials-",
                suffix=".staging",
                dir=directory,
                text=False,
            )
        except OSError:
            _fail("credentials publication failed")
        staging_path = Path(raw_path)
        _write_and_sync_staging(descriptor, payload, failpoint)
        os.close(descriptor)
        descriptor = None
        if staging_path is None:  # pragma: no cover - defensive.
            _fail("credentials publication failed")
        return staging_path
    except ConfigurationError:
        raise
    except BaseException:
        _fail("credentials publication failed")
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if staging_path is not None and descriptor is not None:
            try:
                staging_path.unlink()
            except (FileNotFoundError, OSError):
                pass


def _validate_staging(
    staging_path: Path,
    failpoint: Callable[[str], None] | None,
) -> None:
    staged_raw, _metadata = _read_verified(staging_path, credentials=True, secure=True)
    _credential_payload(staged_raw)
    _call_failpoint(failpoint, "staging-validated")


def _replace_staging(
    staging_path: Path,
    path: Path,
    expected_target: os.stat_result | None,
    failpoint: Callable[[str], None] | None,
) -> None:
    # Re-validate the owner-only directory immediately before the irreversible
    # rename.  This catches a directory replacement/symlink race in addition
    # to the target-file identity check below.
    _secure_directory(path.parent, create=False)
    current = _lstat(path, missing_ok=True, credentials=True)
    if expected_target is None:
        if current is not None:
            _fail("credentials file changed during read")
    elif current is None or not _same_metadata(expected_target, current):
        _fail("credentials file changed during read")
    _call_failpoint(failpoint, "before-replace")
    try:
        os.replace(staging_path, path)
    except OSError:
        _fail("credentials publication failed")


def _sync_directory(path: Path, failpoint: Callable[[str], None] | None) -> None:
    directory_fd = _directory_fd(path.parent)
    try:
        _call_post_commit_observer(failpoint, "before-directory-fsync")
        try:
            os.fsync(directory_fd)
        except OSError:
            _fail("credentials publication failed")
        _call_post_commit_observer(failpoint, "directory-fsynced")
    finally:
        try:
            os.close(directory_fd)
        except OSError:
            _fail("credentials publication failed")


def _atomic_publish(
    path: Path,
    payload: bytes,
    *,
    expected_target: os.stat_result | None,
    failpoint: Callable[[str], None] | None,
) -> None:
    directory = _secure_directory(path.parent, create=True)
    staging_path: Path | None = None
    try:
        staging_path = _stage_credentials(directory, payload, failpoint)
        _validate_staging(staging_path, failpoint)
        _replace_staging(staging_path, path, expected_target, failpoint)
        staging_path = None
        _call_post_commit_observer(failpoint, "after-replace")
        try:
            _sync_directory(path, failpoint)
        except BaseException:
            # Directory durability is still attempted, but a post-commit
            # failure cannot be returned as if the old file were retained.
            pass
    except ConfigurationError:
        raise
    except BaseException:
        _fail("credentials publication failed")
    finally:
        if staging_path is not None:
            try:
                staging_path.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass


def _validated_updates(
    provider: ProviderName | str,
    values: Mapping[str, str],
) -> tuple[ProviderName, dict[str, str]]:
    name = _provider_name(provider)
    if name in _UNSUPPORTED_CREDENTIAL_PROVIDERS:
        _fail("credentials provider is unsupported")
    if name not in _CREDENTIAL_PROVIDER_NAMES:
        _fail("credentials provider is unknown")
    if not isinstance(values, Mapping):
        _fail("credentials value is invalid")
    expected = {field.name for field in _credential_specs(name)}
    result: dict[str, str] = {}
    for field, value in values.items():
        if type(field) is not str or field not in expected:
            _fail("credentials field is unknown")
        result[field] = _credential_value(value)
    if not result:
        _fail("credentials value is invalid")
    return name, result


def set_credentials(
    provider: ProviderName | str,
    values: Mapping[str, str],
    *,
    home: str | Path | None = None,
    failpoint: Callable[[str], None] | None = None,
) -> CredentialLookup:
    """Atomically replace one provider section in the fixed credentials file."""

    name, updates = _validated_updates(provider, values)
    path = credential_path(home=home)
    values_before, metadata_before = _read_credentials(home)
    merged = {provider_name: dict(fields) for provider_name, fields in values_before.items()}
    merged[name] = updates
    payload = _render_credentials(merged)
    _atomic_publish(
        path,
        payload,
        expected_target=metadata_before,
        failpoint=failpoint,
    )
    return _CredentialBundle(
        {provider_name: dict(fields) for provider_name, fields in merged.items()}
    )


def remove_credentials(
    provider: ProviderName | str,
    *,
    home: str | Path | None = None,
    failpoint: Callable[[str], None] | None = None,
) -> CredentialLookup:
    """Atomically remove one provider section, leaving other sections intact."""

    name = _provider_name(provider)
    if name in _UNSUPPORTED_CREDENTIAL_PROVIDERS:
        # Wiley has no accepted section, so removal is a stable no-op after
        # validating the provider name.
        return load_credentials(home=home)
    if name not in _CREDENTIAL_PROVIDER_NAMES:
        _fail("credentials provider is unknown")
    path = credential_path(home=home)
    values_before, metadata_before = _read_credentials(home)
    if name not in values_before:
        return _CredentialBundle(
            {provider_name: dict(fields) for provider_name, fields in values_before.items()}
        )
    del values_before[name]
    payload = _render_credentials(values_before)
    _atomic_publish(
        path,
        payload,
        expected_target=metadata_before,
        failpoint=failpoint,
    )
    return _CredentialBundle(
        {provider_name: dict(fields) for provider_name, fields in values_before.items()}
    )


__all__ = (
    "AcquisitionSourcesConfig",
    "Configuration",
    "ConfigurationDiagnostic",
    "ConfigurationError",
    "ConfigurationProbePort",
    "ConfigurationProbeResult",
    "ConfigurationProbeSummary",
    "ConfigurationStatus",
    "CredentialLookup",
    "CredentialStatus",
    "ProviderCapability",
    "ProviderCredentialStatus",
    "ProviderName",
    "UnpaywallAcquisitionConfig",
    "credential_diagnostic",
    "credential_field_specs",
    "credential_path",
    "credential_section_exists",
    "credential_status_for",
    "configuration_status",
    "load_configuration",
    "load_credentials",
    "load_runtime_secrets",
    "load_selected_configuration",
    "parse_configuration",
    "remove_credentials",
    "run_configuration_probes",
    "RuntimeSecretLookup",
    "select_configuration_path",
    "set_credentials",
)
