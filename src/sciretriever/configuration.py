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

import tomlkit
from pydantic import BaseModel, ValidationError
from tomlkit.exceptions import TOMLKitError

from sciretriever.model.configuration import (
    AccessConfig,
    AcquisitionSourcesConfig,
    AnalysisAuthentication,
    AnalysisConfig,
    AnalysisConfigurationStatus,
    AssetsConfig,
    Configuration,
    ConfigurationCapabilityStatus,
    ConfigurationDiagnostic,
    ConfigurationProbeResult,
    ConfigurationProbeSummary,
    ConfigurationRuntimeStatus,
    ConfigurationStatus,
    CoreCredentialService,
    CredentialFieldSpec,
    CredentialFieldStatus,
    CredentialStatus,
    DiscoveryConfig,
    ExecutionConfig,
    LibraryConfig,
    ParserConnectionMode,
    ParsingConfig,
    ParsingConfigurationStatus,
    PathsConfig,
    ProbeOutcome,
    ProviderCapability,
    ProviderCredentialStatus,
    ProviderName,
    SourcesConfig,
    UnpaywallAcquisitionConfig,
)
from sciretriever.network.policy import PolicyError, normalize_url_with_configured_port

_MAX_CONFIGURATION_BYTES: Final[int] = 1_048_576
_MAX_CREDENTIALS_BYTES: Final[int] = 1_048_576
_CONFIGURATION_ENVIRONMENT: Final[str] = "SCIRETRIEVER_CONFIG"
_CREDENTIALS_DIRECTORY_NAME: Final[str] = ".sciretriever"
_CREDENTIALS_FILE_NAME: Final[str] = "credentials.toml"
_DIRECTORY_MODE: Final[int] = 0o700
_FILE_MODE: Final[int] = 0o600


class _CoreCredentialSpec:
    __slots__ = ("next_secret_field", "secret_field")

    def __init__(self, secret_field: str) -> None:
        self.secret_field = secret_field
        self.next_secret_field = f"next_{secret_field}"


_CORE_CREDENTIAL_SPECS: Final[dict[CoreCredentialService, _CoreCredentialSpec]] = {
    CoreCredentialService.LLM: _CoreCredentialSpec("api_key"),
    CoreCredentialService.MINERU: _CoreCredentialSpec("bearer_token"),
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

    def core_field_names(self, service: CoreCredentialService | str) -> tuple[str, ...]: ...

    def has_core_service(self, service: CoreCredentialService | str) -> bool: ...

    def core_secret_for_origin(
        self,
        service: CoreCredentialService | str,
        origin: str,
    ) -> str | None: ...


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
        "configuration publication failed",
        "configuration publication was interrupted",
        "credentials provider is unknown",
        "credentials field is unknown",
        "credentials provider is unsupported",
        "credentials service is unknown",
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


def select_configuration_edit_path(
    explicit: str | Path | None = None,
    *,
    environment: Mapping[str, str] | None = None,
    cwd: str | Path | None = None,
) -> Path:
    """Select the ordinary config target even when it does not exist yet."""

    if explicit is not None:
        return _safe_path(explicit)
    values = os.environ if environment is None else environment
    selected = values.get(_CONFIGURATION_ENVIRONMENT)
    if selected:
        return _safe_path(selected)
    return (Path.cwd() if cwd is None else _safe_path(cwd)) / "config.toml"


ConfigurationChange = tuple[str, object, object]


def configuration_diff(
    before: Configuration,
    after: Configuration,
    *,
    sections: tuple[str, ...] = ("analysis", "parsing"),
) -> tuple[ConfigurationChange, ...]:
    """Return a stable, non-secret ordinary-configuration field diff."""

    if not isinstance(before, Configuration) or not isinstance(after, Configuration):
        _fail("configuration value is invalid")
    if not isinstance(sections, tuple) or any(
        type(section) is not str or section not in {"analysis", "parsing"} for section in sections
    ):
        _fail("configuration value is invalid")
    before_payload = before.model_dump(mode="json")
    after_payload = after.model_dump(mode="json")
    changes: list[ConfigurationChange] = []
    for section in sections:
        old = before_payload[section]
        new = after_payload[section]
        if not isinstance(old, dict) or not isinstance(new, dict):
            _fail("configuration value is invalid")
        for field in sorted(set(old) | set(new)):
            if old.get(field) != new.get(field):
                changes.append((f"{section}.{field}", old.get(field), new.get(field)))
    return tuple(changes)


def _configuration_document(raw: bytes) -> tomlkit.TOMLDocument:
    if len(raw) > _MAX_CONFIGURATION_BYTES:
        _fail("configuration input is too large")
    try:
        document = tomlkit.parse(raw.decode("utf-8"))
    except (UnicodeDecodeError, TOMLKitError):
        _fail("configuration input is malformed")
    return document


def _configuration_section_payload(value: BaseModel) -> dict[str, object]:
    payload = value.model_dump(mode="json", exclude_none=True)
    if not isinstance(payload, dict):
        _fail("configuration value is invalid")
    return payload


def _replace_document_section(
    document: tomlkit.TOMLDocument,
    section: str,
    value: BaseModel,
) -> None:
    payload = _configuration_section_payload(value)
    current = document.get(section)
    if current is None:
        table = tomlkit.table()
        document[section] = table
    elif isinstance(current, dict):
        table = current
    else:
        _fail("configuration value is invalid")
    for field in tuple(table):
        if field not in payload:
            del table[field]
    for field, field_value in payload.items():
        table[field] = field_value


def _read_editable_configuration(path: Path) -> tuple[bytes, os.stat_result | None]:
    metadata = _lstat(path, missing_ok=True, credentials=False)
    if metadata is None:
        return b"", None
    raw, final = _read_verified(path, credentials=False, secure=False)
    return raw, final


def load_editable_configuration(path: str | Path) -> Configuration:
    """Load an editable ordinary config, treating a missing target as empty."""

    selected = _safe_path(path)
    raw, _metadata = _read_editable_configuration(selected)
    return _empty_configuration() if not raw else _parse_configuration_payload(raw)


def _stage_configuration(
    path: Path,
    payload: bytes,
    failpoint: Callable[[str], None] | None,
) -> Path:
    if len(payload) > _MAX_CONFIGURATION_BYTES:
        _fail("configuration input is too large")
    descriptor: int | None = None
    staging: Path | None = None
    try:
        try:
            descriptor, raw_path = tempfile.mkstemp(
                prefix=".config-",
                suffix=".staging",
                dir=path.parent,
                text=False,
            )
        except OSError:
            _fail("configuration publication failed")
        staging = Path(raw_path)
        try:
            os.fchmod(descriptor, _FILE_MODE)
            _call_configuration_failpoint(failpoint, "staging-created")
            _write_configuration_bytes(descriptor, payload)
            _call_configuration_failpoint(failpoint, "staging-written")
            os.fsync(descriptor)
        except OSError:
            _fail("configuration publication failed")
        _call_configuration_failpoint(failpoint, "staging-fsynced")
        os.close(descriptor)
        descriptor = None
        return staging
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
            if staging is not None:
                try:
                    staging.unlink()
                except OSError:
                    pass


def _write_configuration_bytes(descriptor: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        try:
            written = os.write(descriptor, payload[offset:])
        except OSError:
            _fail("configuration publication failed")
        if written <= 0:
            _fail("configuration publication failed")
        offset += written


def _call_configuration_failpoint(
    failpoint: Callable[[str], None] | None,
    name: str,
) -> None:
    if failpoint is None:
        return
    try:
        failpoint(name)
    except ConfigurationError:
        raise
    except BaseException:
        _fail("configuration publication was interrupted")


def _open_directory_for_sync(path: Path) -> int:
    flags = os.O_RDONLY
    for name in ("O_CLOEXEC", "O_DIRECTORY", "O_BINARY"):
        value = getattr(os, name, 0)
        if isinstance(value, int):
            flags |= value
    try:
        return os.open(path, flags)
    except OSError:
        _fail("configuration publication failed")


def _replace_configuration_staging(
    staging: Path,
    path: Path,
    expected: os.stat_result | None,
    failpoint: Callable[[str], None] | None,
) -> None:
    current = _lstat(path, missing_ok=True, credentials=False)
    if expected is None:
        if current is not None:
            _fail("configuration file changed during read")
    elif current is None or not _same_metadata(expected, current):
        _fail("configuration file changed during read")
    _call_configuration_failpoint(failpoint, "before-replace")
    try:
        os.replace(staging, path)
    except OSError:
        _fail("configuration publication failed")


def _publish_configuration(
    path: Path,
    payload: bytes,
    expected: os.stat_result | None,
    failpoint: Callable[[str], None] | None,
) -> None:
    staging: Path | None = None
    directory_fd: int | None = None
    try:
        try:
            path.parent.mkdir(mode=_DIRECTORY_MODE, parents=True, exist_ok=True)
        except OSError:
            _fail("configuration directory is unavailable")
        staging = _stage_configuration(path, payload, failpoint)
        staged_raw, _metadata = _read_verified(staging, credentials=False, secure=True)
        _parse_configuration_payload(staged_raw)
        _call_configuration_failpoint(failpoint, "staging-validated")
        _replace_configuration_staging(staging, path, expected, failpoint)
        staging = None
        try:
            directory_fd = _open_directory_for_sync(path.parent)
            os.fsync(directory_fd)
        except OSError:
            _fail("configuration publication failed")
    finally:
        if directory_fd is not None:
            try:
                os.close(directory_fd)
            except OSError:
                pass
        if staging is not None:
            try:
                staging.unlink()
            except OSError:
                pass


def _prepare_configuration_staging(path: Path, payload: bytes) -> Path:
    try:
        path.parent.mkdir(mode=_DIRECTORY_MODE, parents=True, exist_ok=True)
    except OSError:
        _fail("configuration directory is unavailable")
    staging = _stage_configuration(path, payload, None)
    try:
        staged_raw, _metadata = _read_verified(staging, credentials=False, secure=True)
        _parse_configuration_payload(staged_raw)
        return staging
    except BaseException:
        try:
            staging.unlink()
        except OSError:
            pass
        raise


def _commit_configuration_staging(
    staging: Path,
    path: Path,
    expected: os.stat_result | None,
) -> None:
    _replace_configuration_staging(staging, path, expected, None)
    directory_fd: int | None = None
    try:
        directory_fd = _open_directory_for_sync(path.parent)
        os.fsync(directory_fd)
    except BaseException:
        # The rename is already visible.  As with credentials publication,
        # durability is attempted but a post-commit failure cannot restore
        # the old file or be reported as if it were retained.
        pass
    finally:
        if directory_fd is not None:
            try:
                os.close(directory_fd)
            except OSError:
                pass


def update_configuration_sections(
    path: str | Path,
    *,
    analysis: AnalysisConfig | None = None,
    parsing: ParsingConfig | None = None,
    failpoint: Callable[[str], None] | None = None,
) -> Configuration:
    """Round-trip and atomically publish selected ordinary config sections."""

    selected = _safe_path(path)
    if analysis is None and parsing is None:
        _fail("configuration value is invalid")
    if analysis is not None and not isinstance(analysis, AnalysisConfig):
        _fail("configuration value is invalid")
    if parsing is not None and not isinstance(parsing, ParsingConfig):
        _fail("configuration value is invalid")
    payload, expected, configuration = _configuration_update_payload(
        selected,
        analysis=analysis,
        parsing=parsing,
    )
    _publish_configuration(selected, payload, expected, failpoint)
    return configuration


def _configuration_update_payload(
    path: Path,
    *,
    analysis: AnalysisConfig | None = None,
    parsing: ParsingConfig | None = None,
) -> tuple[bytes, os.stat_result | None, Configuration]:
    raw, expected = _read_editable_configuration(path)
    document = _configuration_document(raw)
    if analysis is not None:
        _replace_document_section(document, "analysis", analysis)
    if parsing is not None:
        _replace_document_section(document, "parsing", parsing)
    try:
        payload = tomlkit.dumps(document).encode("utf-8")
    except (TOMLKitError, UnicodeEncodeError, ValueError, TypeError):
        _fail("configuration value is invalid")
    return payload, expected, _parse_configuration_payload(payload)


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
    include_analysis: bool = True,
) -> RuntimeSecretLookup:
    """Select origin-bound Parser/Analysis secrets from credentials.toml."""

    if type(include_parser) is not bool or type(include_analysis) is not bool:
        _fail("configuration value is invalid")
    if credentials is not None and credentials_home is not None:
        _fail("configuration value is invalid")
    if credentials is not None and not isinstance(credentials, CredentialLookup):
        _fail("configuration value is invalid")
    if not isinstance(configuration, Configuration):
        _fail("configuration value is invalid")
    parser = configuration.parsing
    analysis = configuration.analysis
    parser_needs_secret = include_parser and parser.connection_mode is ParserConnectionMode.REMOTE
    analysis_needs_secret = (
        include_analysis and analysis.authentication is AnalysisAuthentication.API_KEY
    )
    bundle = (
        load_credentials(home=credentials_home)
        if credentials is None and (parser_needs_secret or analysis_needs_secret)
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
    if not include_analysis:
        analysis_key = None
    elif analysis.authentication is AnalysisAuthentication.NONE:
        analysis_key = None
    elif analysis.authentication is AnalysisAuthentication.API_KEY:
        assert bundle is not None
        analysis_key = _bound_core_secret(
            bundle,
            CoreCredentialService.LLM,
            _CORE_CREDENTIAL_SPECS[CoreCredentialService.LLM].secret_field,
            _service_origin(analysis.base_url),
        )
    else:
        _fail("configuration value is invalid")
    return _RuntimeSecrets(
        mineru_bearer_token=mineru,
        analysis_api_key=analysis_key,
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
        has_authorized_source = any(
            mapping.capability.value == "authorized-provider-api" and mapping.production_available
            for mapping in status.mappings
        )
        has_authorized_mapping = any(
            mapping.capability.value == "authorized-provider-api" for mapping in status.mappings
        )
        credential = (
            _credential_status(
                provider,
                ProviderCapability.ACQUISITION,
                credentials.field_names(provider),
                section_present=credentials.has_provider(provider),
                production_supported=has_authorized_source,
            )
            if has_authorized_mapping
            else ProviderCredentialStatus(
                provider=provider,
                capability=ProviderCapability.ACQUISITION,
                status=(
                    CredentialStatus.NOT_REQUIRED if production else CredentialStatus.UNSUPPORTED
                ),
            )
        )
        policy = production
        credential_ready = (
            not has_authorized_source or credential.status in _READY_CREDENTIAL_STATUSES
        )
        local_ready = status.ready and credential_ready
        failure_code = status.failure_code
        if status.ready and not credential_ready:
            failure_code = "missing-required-credential"
        result[provider] = ConfigurationCapabilityStatus(
            provider=provider,
            capability=ProviderCapability.ACQUISITION,
            production_available=production,
            enabled=status.enabled,
            ordinary_parameters_ready=ordinary,
            credential=credential,
            access_policy_ready=policy,
            probe_available=False,
            local_ready=local_ready,
            failure_code=failure_code,
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


def _core_credential_presence(
    credentials: CredentialLookup,
    service: CoreCredentialService,
    secret_field: str,
    base_url: str | None,
) -> tuple[bool, bool]:
    del secret_field
    present = credentials.has_core_service(service)
    if base_url is None:
        return present, False
    try:
        expected_origin = _service_origin(base_url)
    except ConfigurationError:
        return present, False
    return present, credentials.core_secret_for_origin(service, expected_origin) is not None


def configuration_runtime_status(
    configuration: Configuration,
    *,
    credentials: CredentialLookup | None = None,
    credentials_home: str | Path | None = None,
) -> ConfigurationRuntimeStatus:
    """Report local Storage, MinerU, and Analysis configuration completeness.

    This is a presence-only diagnostic.  It does not bind Storage, contact a
    Parser or LLM service, or retain an environment value.
    """

    if not isinstance(configuration, Configuration):
        _fail("configuration value is invalid")
    if credentials is not None and credentials_home is not None:
        _fail("configuration value is invalid")
    if credentials is not None and not isinstance(credentials, CredentialLookup):
        _fail("configuration value is invalid")
    storage_missing = tuple(
        name
        for name, value in (
            ("catalog_path", configuration.paths.catalog_path),
            ("artifact_root", configuration.paths.artifact_root),
        )
        if value is None
    )

    parser = configuration.parsing
    analysis = configuration.analysis
    bearer_required = parser.connection_mode is ParserConnectionMode.REMOTE
    api_key_required = analysis.authentication is AnalysisAuthentication.API_KEY
    bundle = (
        load_credentials(home=credentials_home)
        if credentials is None and (bearer_required or api_key_required)
        else credentials
    )
    parsing_missing = [
        name
        for name, value in (
            ("base_url", parser.base_url),
            ("connection_mode", parser.connection_mode),
            ("model_identity", parser.model_identity),
        )
        if value is None
    ]
    if bearer_required and not parser.remote_upload_authorized:
        parsing_missing.append("remote_upload_authorized")
    if bearer_required:
        assert bundle is not None
        parser_token_present, parser_origin_matches = _core_credential_presence(
            bundle,
            CoreCredentialService.MINERU,
            _CORE_CREDENTIAL_SPECS[CoreCredentialService.MINERU].secret_field,
            parser.base_url,
        )
    else:
        parser_token_present, parser_origin_matches = False, False
    parsing_status = ParsingConfigurationStatus(
        configuration_complete=not parsing_missing,
        bearer_token_required=bearer_required,
        bearer_token_configured=(parser_token_present if bearer_required else None),
        credential_origin_matches=parser_origin_matches if bearer_required else None,
        missing_fields=tuple(parsing_missing),
    )

    reference_fields = (
        ("provider", analysis.provider),
        ("protocol", analysis.protocol),
        ("base_url", analysis.base_url),
        ("model", analysis.model),
        ("context_window_tokens", analysis.context_window_tokens),
        ("authentication", analysis.authentication),
        ("reference_max_output_tokens", analysis.reference_max_output_tokens),
    )
    content_fields = (
        ("provider", analysis.provider),
        ("protocol", analysis.protocol),
        ("base_url", analysis.base_url),
        ("model", analysis.model),
        ("context_window_tokens", analysis.context_window_tokens),
        ("authentication", analysis.authentication),
        ("metadata_max_output_tokens", analysis.metadata_max_output_tokens),
        ("content_max_output_tokens", analysis.content_max_output_tokens),
        ("reference_max_output_tokens", analysis.reference_max_output_tokens),
        ("max_input_bytes", analysis.max_input_bytes),
        ("max_chunk_bytes", analysis.max_chunk_bytes),
        ("max_chunk_count", analysis.max_chunk_count),
        ("max_total_llm_requests", analysis.max_total_llm_requests),
        ("max_total_output_tokens", analysis.max_total_output_tokens),
    )
    reference_missing = tuple(name for name, value in reference_fields if value is None)
    content_missing = tuple(name for name, value in content_fields if value is None)
    if api_key_required:
        assert bundle is not None
        api_key_present, analysis_origin_matches = _core_credential_presence(
            bundle,
            CoreCredentialService.LLM,
            _CORE_CREDENTIAL_SPECS[CoreCredentialService.LLM].secret_field,
            analysis.base_url,
        )
    else:
        api_key_present, analysis_origin_matches = False, False
    analysis_status = AnalysisConfigurationStatus(
        api_key_required=api_key_required,
        api_key_configured=api_key_present if api_key_required else None,
        credential_origin_matches=analysis_origin_matches if api_key_required else None,
        reference_configuration_complete=not reference_missing,
        content_configuration_complete=not content_missing,
        reference_missing_fields=reference_missing,
        content_missing_fields=content_missing,
    )
    return ConfigurationRuntimeStatus(
        storage_configuration_complete=not storage_missing,
        storage_missing_fields=storage_missing,
        parsing=parsing_status,
        analysis=analysis_status,
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


def _render_credentials(
    values: Mapping[ProviderName, Mapping[str, str]],
    core: Mapping[CoreCredentialService, Mapping[str, str]],
) -> bytes:
    lines: list[str] = []
    for service in CoreCredentialService:
        section = core.get(service)
        if not section:
            continue
        lines.append(f"[{service.value}]\n")
        for field in sorted(section):
            lines.append(f"{field} = {_toml_quote(section[field])}\n")
        lines.append("\n")
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


def _core_section(secret: str, origin: str, service: CoreCredentialService) -> dict[str, str]:
    spec = _CORE_CREDENTIAL_SPECS[service]
    return {
        spec.secret_field: _credential_value(secret),
        _CORE_ORIGIN_FIELD: _canonical_credential_origin(origin),
    }


def _transition_core_section(
    current: Mapping[str, str],
    replacement: Mapping[str, str],
    service: CoreCredentialService,
) -> dict[str, str]:
    spec = _CORE_CREDENTIAL_SPECS[service]
    if current.get(_CORE_ORIGIN_FIELD) == replacement[_CORE_ORIGIN_FIELD]:
        return dict(replacement)
    primary_secret = current.get(spec.secret_field)
    primary_origin = current.get(_CORE_ORIGIN_FIELD)
    if primary_secret is None or primary_origin is None:
        _fail("credentials value is invalid")
    return {
        spec.secret_field: primary_secret,
        _CORE_ORIGIN_FIELD: primary_origin,
        spec.next_secret_field: replacement[spec.secret_field],
        _CORE_NEXT_ORIGIN_FIELD: replacement[_CORE_ORIGIN_FIELD],
    }


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


def _prepare_credentials_staging(path: Path, payload: bytes) -> Path:
    directory = _secure_directory(path.parent, create=True)
    staging = _stage_credentials(directory, payload, None)
    try:
        _validate_staging(staging, None)
        return staging
    except BaseException:
        try:
            staging.unlink()
        except OSError:
            pass
        raise


def _commit_credentials_staging(
    staging: Path,
    path: Path,
    expected: os.stat_result | None,
) -> None:
    _replace_staging(staging, path, expected, None)
    try:
        _sync_directory(path, None)
    except BaseException:
        # The rename is the commit point; directory durability was attempted.
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
    values_before, core_before, metadata_before = _read_credentials(home)
    merged = {provider_name: dict(fields) for provider_name, fields in values_before.items()}
    merged[name] = updates
    payload = _render_credentials(merged, core_before)
    _atomic_publish(
        path,
        payload,
        expected_target=metadata_before,
        failpoint=failpoint,
    )
    return _CredentialBundle(
        {provider_name: dict(fields) for provider_name, fields in merged.items()},
        {service: dict(fields) for service, fields in core_before.items()},
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
        return load_credentials(home=home)
    if name not in _CREDENTIAL_PROVIDER_NAMES:
        _fail("credentials provider is unknown")
    path = credential_path(home=home)
    values_before, core_before, metadata_before = _read_credentials(home)
    if name not in values_before:
        return _CredentialBundle(
            {provider_name: dict(fields) for provider_name, fields in values_before.items()},
            {service: dict(fields) for service, fields in core_before.items()},
        )
    del values_before[name]
    payload = _render_credentials(values_before, core_before)
    _atomic_publish(
        path,
        payload,
        expected_target=metadata_before,
        failpoint=failpoint,
    )
    return _CredentialBundle(
        {provider_name: dict(fields) for provider_name, fields in values_before.items()},
        {service: dict(fields) for service, fields in core_before.items()},
    )


def set_core_credentials(
    service: CoreCredentialService | str,
    *,
    secret: str,
    origin: str,
    home: str | Path | None = None,
    failpoint: Callable[[str], None] | None = None,
) -> CredentialLookup:
    """Atomically replace one origin-bound core-service secret section."""

    name = _core_service_name(service)
    section = _core_section(secret, origin, name)
    path = credential_path(home=home)
    providers_before, core_before, metadata_before = _read_credentials(home)
    merged_core = {item: dict(fields) for item, fields in core_before.items()}
    merged_core[name] = section
    payload = _render_credentials(providers_before, merged_core)
    _atomic_publish(
        path,
        payload,
        expected_target=metadata_before,
        failpoint=failpoint,
    )
    return _CredentialBundle(
        {provider: dict(fields) for provider, fields in providers_before.items()},
        {item: dict(fields) for item, fields in merged_core.items()},
    )


def remove_core_credentials(
    service: CoreCredentialService | str,
    *,
    home: str | Path | None = None,
    failpoint: Callable[[str], None] | None = None,
) -> CredentialLookup:
    """Atomically remove one core-service secret section."""

    name = _core_service_name(service)
    path = credential_path(home=home)
    providers_before, core_before, metadata_before = _read_credentials(home)
    if name not in core_before:
        return _CredentialBundle(providers_before, core_before)
    del core_before[name]
    payload = _render_credentials(providers_before, core_before)
    _atomic_publish(
        path,
        payload,
        expected_target=metadata_before,
        failpoint=failpoint,
    )
    return _CredentialBundle(providers_before, core_before)


def _core_credential_versions(
    name: CoreCredentialService,
    current_core: Mapping[CoreCredentialService, Mapping[str, str]],
    replacement: Mapping[str, str] | None,
) -> tuple[
    dict[CoreCredentialService, dict[str, str]],
    dict[CoreCredentialService, dict[str, str]],
]:
    merged = {item: dict(fields) for item, fields in current_core.items()}
    transitional = {item: dict(fields) for item, fields in merged.items()}
    final = {item: dict(fields) for item, fields in merged.items()}
    if replacement is None:
        final.pop(name, None)
        return transitional, final
    final[name] = dict(replacement)
    current = merged.get(name)
    transitional[name] = (
        dict(replacement)
        if current is None
        else _transition_core_section(current, replacement, name)
    )
    return transitional, final


def _prepare_core_update_stagings(
    *,
    selected: Path,
    configuration_payload: bytes,
    credentials_target: Path,
    transition_payload: bytes,
    final_payload: bytes,
    credentials_changed: bool,
    final_credentials_changed: bool,
) -> tuple[Path, Path | None, Path | None]:
    configuration_staging: Path | None = None
    transition_staging: Path | None = None
    final_staging: Path | None = None
    try:
        configuration_staging = _prepare_configuration_staging(
            selected,
            configuration_payload,
        )
        if credentials_changed:
            transition_staging = _prepare_credentials_staging(
                credentials_target,
                transition_payload,
            )
        if final_credentials_changed:
            final_staging = _prepare_credentials_staging(
                credentials_target,
                final_payload,
            )
        return configuration_staging, transition_staging, final_staging
    except BaseException:
        _cleanup_stagings(configuration_staging, transition_staging, final_staging)
        raise


def _cleanup_stagings(*stagings: Path | None) -> None:
    for staging in stagings:
        if staging is None:
            continue
        try:
            staging.unlink()
        except OSError:
            pass


def update_core_service_configuration(
    path: str | Path,
    service: CoreCredentialService | str,
    *,
    analysis: AnalysisConfig | None = None,
    parsing: ParsingConfig | None = None,
    secret: str | None,
    origin: str | None,
    home: str | Path | None = None,
    failpoint: Callable[[str], None] | None = None,
) -> Configuration:
    """Publish one core service's ordinary settings and secret safely.

    The two files cannot share one filesystem rename.  When a credentialed
    endpoint changes, a short-lived transition section first makes both the
    old and new origins usable.  The ordinary configuration is then
    published, after which the credential section is collapsed to the new
    origin.  An interruption at either commit point therefore leaves either
    the old or the new ordinary configuration runnable.
    """

    name = _core_service_name(service)
    if (name is CoreCredentialService.LLM) != (analysis is not None) or (
        name is CoreCredentialService.MINERU
    ) != (parsing is not None):
        _fail("configuration value is invalid")
    if (secret is None) != (origin is None):
        _fail("configuration value is invalid")
    selected = _safe_path(path)
    configuration_payload, configuration_expected, configuration = _configuration_update_payload(
        selected,
        analysis=analysis,
        parsing=parsing,
    )
    credentials_target = credential_path(home=home)
    providers, current_core, credentials_expected = _read_credentials(home)
    replacement = None if secret is None else _core_section(secret, origin or "", name)
    transitional_core, final_core = _core_credential_versions(
        name,
        current_core,
        replacement,
    )
    transition_payload = _render_credentials(providers, transitional_core)
    final_payload = _render_credentials(providers, final_core)
    credentials_changed = transitional_core != current_core
    final_credentials_changed = final_core != transitional_core
    # Cross-directory atomicity is impossible.  Prepare, fsync, and fully
    # reparse every file that may be committed before publishing the first
    # one.  The transition credentials keep both old and new origins runnable
    # across the two visible commit points.
    configuration_staging, transition_staging, final_staging = _prepare_core_update_stagings(
        selected=selected,
        configuration_payload=configuration_payload,
        credentials_target=credentials_target,
        transition_payload=transition_payload,
        final_payload=final_payload,
        credentials_changed=credentials_changed,
        final_credentials_changed=final_credentials_changed,
    )
    try:
        _call_configuration_failpoint(failpoint, "all-stagings-validated")

        if transition_staging is not None:
            _commit_credentials_staging(
                transition_staging,
                credentials_target,
                credentials_expected,
            )
            transition_staging = None
            _providers, _core, credentials_expected = _read_credentials(home)
            del _providers, _core
        if credentials_changed:
            # Keep the observation stable even when the replacement used the
            # same origin and did not require a two-origin recovery section.
            _call_configuration_failpoint(failpoint, "credentials-transition-published")

        assert configuration_staging is not None
        _commit_configuration_staging(
            configuration_staging,
            selected,
            configuration_expected,
        )
        configuration_staging = None
        _call_configuration_failpoint(failpoint, "configuration-published")

        if final_staging is not None:
            _call_configuration_failpoint(failpoint, "before-credentials-finalize")
            _commit_credentials_staging(
                final_staging,
                credentials_target,
                credentials_expected,
            )
            final_staging = None
            _call_post_commit_observer(failpoint, "credentials-finalized")
    finally:
        _cleanup_stagings(
            configuration_staging,
            transition_staging,
            final_staging,
        )
    return configuration


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
    "configurable_credential_providers",
    "configuration_diff",
    "configuration_service_origin",
    "core_credential_section_exists",
    "credential_diagnostic",
    "credential_field_specs",
    "credential_path",
    "credential_section_exists",
    "credential_status_for",
    "configuration_status",
    "configuration_runtime_status",
    "load_configuration",
    "load_editable_configuration",
    "load_credentials",
    "load_runtime_secrets",
    "load_selected_configuration",
    "parse_configuration",
    "remove_credentials",
    "remove_core_credentials",
    "run_configuration_probes",
    "RuntimeSecretLookup",
    "select_configuration_path",
    "select_configuration_edit_path",
    "set_credentials",
    "set_core_credentials",
    "update_configuration_sections",
    "update_core_service_configuration",
)
