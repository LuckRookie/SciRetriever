"""Strict, side-effect-free access to SciRetriever configuration."""

from __future__ import annotations

import math
import os
import stat
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import Any

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - exercised on Python 3.10
    import tomli as tomllib

from sciretriever.errors import ConfigError


STORAGE_ROOT_ENV = "SCIRETRIEVER_STORAGE_ROOT"
CONFIG_ENV = "SCIRETRIEVER_CONFIG"
MAX_CONFIG_BYTES = 1024 * 1024

_ROOT_KEYS = {"schema_version", "paths", "credentials", "discovery", "search", "acquisition", "package"}
_CREDENTIAL_KEYS = {
    "unpaywall_email",
    "semantic_scholar_api_key",
    "elsevier_api_key",
    "wiley_api_key",
    "springer_api_key",
}
_DISCOVERY_SOURCES = {
    "crossref", "europe-pmc", "arxiv", "openalex", "semantic-scholar",
    "elsevier", "springer",
}
METADATA_PROVIDERS = frozenset(_DISCOVERY_SOURCES)
ACQUISITION_PROVIDERS = frozenset({
    "direct", "arxiv", "crossref", "unpaywall", "europe-pmc", "openalex",
    "semantic-scholar", "elsevier", "wiley", "springer",
})
_ASSET_ROLES = {"primary_pdf", "supplementary_pdf", "xml", "html"}


@dataclass(frozen=True, slots=True)
class PathsConfig:
    catalog: Path | None = None
    storage_root: Path | None = None


@dataclass(frozen=True, slots=True)
class CredentialsConfig:
    unpaywall_email: str | None = field(default=None, repr=False)
    semantic_scholar_api_key: str | None = field(default=None, repr=False)
    elsevier_api_key: str | None = field(default=None, repr=False)
    wiley_api_key: str | None = field(default=None, repr=False)
    springer_api_key: str | None = field(default=None, repr=False)

    def get(self, name: str) -> str | None:
        if name not in _CREDENTIAL_KEYS:
            raise KeyError(name)
        return getattr(self, name)


@dataclass(frozen=True, slots=True)
class DiscoveryConfig:
    sources: tuple[str, ...] | None = None
    limit: int | None = None
    timeout: float | None = None
    taxonomy: str | None = None
    taxonomy_version: str | None = None
    crossref_mailto: str | None = None
    filters: tuple[tuple[str, str], ...] = ()
    label_rules: tuple[tuple[str, tuple[str, ...]], ...] = ()


@dataclass(frozen=True, slots=True)
class SearchConfig:
    level: str | None = None
    limit: int | None = None
    providers: tuple[str, ...] | None = None
    precedence: tuple[str, ...] | None = None
    provider_timeout: float | None = None
    max_concurrency: int | None = None
    crossref_mailto: str | None = None


@dataclass(frozen=True, slots=True)
class PreflightConfig:
    min_free_bytes: int = 1024 * 1024 * 1024
    max_asset_bytes: int = 100 * 1024 * 1024
    readiness: str = "none"
    timeout: float = 10.0


@dataclass(frozen=True, slots=True)
class AcquisitionConfig:
    providers: tuple[str, ...] | None = None
    source_plan: Path | None = None
    routing: str | None = None
    asset_role: str | None = None
    timeout: float | None = None
    host_concurrency: int | None = None
    host_min_interval: float | None = None
    forbidden_urls: Path | None = None
    preflight: PreflightConfig = PreflightConfig()


@dataclass(frozen=True, slots=True)
class PackageConfig:
    max_input_bytes: int | None = None
    max_pages: int | None = None
    max_structural_units: int | None = None
    max_depth: int | None = None
    max_elements: int | None = None
    max_text_characters: int | None = None
    summary_max_characters: int | None = None
    enrichment: bool | None = None


@dataclass(frozen=True, slots=True)
class SciRetrieverConfig:
    schema_version: int
    paths: PathsConfig = PathsConfig()
    credentials: CredentialsConfig = field(default_factory=CredentialsConfig, repr=False)
    discovery: DiscoveryConfig = DiscoveryConfig()
    search: SearchConfig = SearchConfig()
    acquisition: AcquisitionConfig = AcquisitionConfig()
    package: PackageConfig = PackageConfig()


def _error(field_name: str, requirement: str) -> ConfigError:
    return ConfigError(f"config field {field_name} {requirement}")


def _table(root: Mapping[str, Any], name: str, allowed: set[str]) -> Mapping[str, Any]:
    value = root.get(name, {})
    if not isinstance(value, dict):
        raise _error(name, "must be a table")
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ConfigError(f"unknown config field: {name}.{unknown[0]}")
    return value


def _nonblank(value: Any, name: str, *, credential: bool = False) -> str:
    if not isinstance(value, str) or not value.strip():
        requirement = "must be a nonblank string"
        raise _error(name, requirement)
    return value.strip() if credential else value


def _optional_string(table: Mapping[str, Any], name: str, prefix: str) -> str | None:
    return None if name not in table else _nonblank(table[name], f"{prefix}.{name}")


def _positive_int(value: Any, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise _error(name, "must be a positive integer")
    return value


def _nonnegative_int(value: Any, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise _error(name, "must be a nonnegative integer")
    return value


def _optional_limit(value: Any, name: str) -> int | None:
    if value is False:
        return None
    return _positive_int(value, name)


def _positive_number(value: Any, name: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise _error(name, "must be a positive finite number")
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise _error(name, "must be a positive finite number")
    return parsed


def _nonnegative_number(value: Any, name: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise _error(name, "must be a nonnegative finite number")
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < 0:
        raise _error(name, "must be a nonnegative finite number")
    return parsed


def _string_list(value: Any, name: str, *, nonempty: bool = False) -> tuple[str, ...]:
    if not isinstance(value, list) or (nonempty and not value):
        qualifier = "nonempty " if nonempty else ""
        raise _error(name, f"must be a {qualifier}string list")
    result = tuple(_nonblank(item, name) for item in value)
    if len(set(result)) != len(result):
        raise _error(name, "must not contain duplicate values")
    return result


def _choice(value: Any, name: str, choices: set[str]) -> str:
    parsed = _nonblank(value, name)
    if parsed not in choices:
        raise _error(name, "has an unsupported value")
    return parsed


def _config_path(value: Any, name: str, parent: Path) -> Path:
    raw = _nonblank(value, name)
    expanded = Path(raw).expanduser()
    if not expanded.is_absolute():
        expanded = parent / expanded
    return expanded.resolve(strict=False)


def _parse_paths(root: Mapping[str, Any], parent: Path) -> PathsConfig:
    table = _table(root, "paths", {"catalog", "storage_root"})
    return PathsConfig(
        catalog=None if "catalog" not in table else _config_path(table["catalog"], "paths.catalog", parent),
        storage_root=None if "storage_root" not in table else _config_path(table["storage_root"], "paths.storage_root", parent),
    )


def _parse_credentials(root: Mapping[str, Any]) -> CredentialsConfig:
    table = _table(root, "credentials", _CREDENTIAL_KEYS)
    values = {
        name: _nonblank(table[name], f"credentials.{name}", credential=True)
        for name in _CREDENTIAL_KEYS
        if name in table
    }
    return CredentialsConfig(**values)


def _parse_discovery(root: Mapping[str, Any]) -> DiscoveryConfig:
    allowed = {"sources", "limit", "timeout", "taxonomy", "taxonomy_version", "crossref_mailto", "filters", "label_rules"}
    table = _table(root, "discovery", allowed)
    sources = None
    if "sources" in table:
        sources = _string_list(table["sources"], "discovery.sources", nonempty=True)
        if any(source not in _DISCOVERY_SOURCES for source in sources):
            raise _error("discovery.sources", "contains an unsupported source")
    filters_table = _table(table, "filters", {"year_from", "year_to"})
    filters: list[tuple[str, str]] = []
    for name in ("year_from", "year_to"):
        if name in filters_table:
            year = _positive_int(filters_table[name], f"discovery.filters.{name}")
            if year > 9999:
                raise _error(f"discovery.filters.{name}", "must be a year from 1 through 9999")
            filters.append((name, str(year)))
    if len(filters) == 2 and int(filters[0][1]) > int(filters[1][1]):
        raise _error("discovery.filters.year_from", "must not be later than year_to")
    rules_table = _table(table, "label_rules", set(table.get("label_rules", {})) if isinstance(table.get("label_rules", {}), dict) else set())
    rules = tuple(
        (label, _string_list(terms, f"discovery.label_rules.{label}", nonempty=True))
        for label, terms in rules_table.items()
        if _nonblank(label, "discovery.label_rules label")
    )
    return DiscoveryConfig(
        sources=sources,
        limit=None if "limit" not in table else _positive_int(table["limit"], "discovery.limit"),
        timeout=None if "timeout" not in table else _positive_number(table["timeout"], "discovery.timeout"),
        taxonomy=_optional_string(table, "taxonomy", "discovery"),
        taxonomy_version=_optional_string(table, "taxonomy_version", "discovery"),
        crossref_mailto=_optional_string(table, "crossref_mailto", "discovery"),
        filters=tuple(filters),
        label_rules=rules,
    )


def _parse_search(root: Mapping[str, Any]) -> SearchConfig:
    allowed = {
        "level", "limit", "providers", "precedence", "provider_timeout",
        "max_concurrency", "crossref_mailto",
    }
    table = _table(root, "search", allowed)
    has_providers = "providers" in table
    has_precedence = "precedence" in table
    if has_providers != has_precedence:
        raise _error("search", "must define providers and precedence together")
    providers = None
    precedence = None
    if has_providers:
        providers = _string_list(table["providers"], "search.providers", nonempty=True)
        precedence = _string_list(table["precedence"], "search.precedence", nonempty=True)
        if any(provider not in METADATA_PROVIDERS for provider in providers):
            raise _error("search.providers", "contains an unsupported provider")
        if any(provider not in METADATA_PROVIDERS for provider in precedence):
            raise _error("search.precedence", "contains an unsupported provider")
        if set(precedence) != set(providers):
            raise _error("search.precedence", "must contain every configured provider exactly once")
    return SearchConfig(
        level=None if "level" not in table else _choice(table["level"], "search.level", {"metadata"}),
        limit=None if "limit" not in table else _positive_int(table["limit"], "search.limit"),
        providers=providers,
        precedence=precedence,
        provider_timeout=None if "provider_timeout" not in table else _positive_number(
            table["provider_timeout"], "search.provider_timeout"
        ),
        max_concurrency=None if "max_concurrency" not in table else _positive_int(
            table["max_concurrency"], "search.max_concurrency"
        ),
        crossref_mailto=_optional_string(table, "crossref_mailto", "search"),
    )


def _parse_acquisition(root: Mapping[str, Any], parent: Path) -> AcquisitionConfig:
    allowed = {"providers", "source_plan", "routing", "asset_role", "timeout", "host_concurrency", "host_min_interval", "forbidden_urls", "preflight"}
    table = _table(root, "acquisition", allowed)
    if "providers" in table and "source_plan" in table:
        raise _error("acquisition", "must not define both providers and source_plan")
    providers = None
    if "providers" in table:
        providers = _string_list(table["providers"], "acquisition.providers", nonempty=True)
        if any(provider not in ACQUISITION_PROVIDERS for provider in providers):
            raise _error("acquisition.providers", "contains an unsupported provider")
    preflight_table = _table(
        table, "preflight", {"min_free_bytes", "max_asset_bytes", "readiness", "timeout"}
    )
    preflight = PreflightConfig(
        min_free_bytes=1024 * 1024 * 1024 if "min_free_bytes" not in preflight_table else _nonnegative_int(
            preflight_table["min_free_bytes"], "acquisition.preflight.min_free_bytes"
        ),
        max_asset_bytes=100 * 1024 * 1024 if "max_asset_bytes" not in preflight_table else _positive_int(
            preflight_table["max_asset_bytes"], "acquisition.preflight.max_asset_bytes"
        ),
        readiness="none" if "readiness" not in preflight_table else _choice(
            preflight_table["readiness"], "acquisition.preflight.readiness", {"none", "headers"}
        ),
        timeout=10.0 if "timeout" not in preflight_table else _positive_number(
            preflight_table["timeout"], "acquisition.preflight.timeout"
        ),
    )
    if preflight.min_free_bytes < preflight.max_asset_bytes:
        raise _error(
            "acquisition.preflight.min_free_bytes",
            "must be at least max_asset_bytes",
        )
    return AcquisitionConfig(
        providers=providers,
        source_plan=None if "source_plan" not in table else _config_path(table["source_plan"], "acquisition.source_plan", parent),
        routing=None if "routing" not in table else _choice(table["routing"], "acquisition.routing", {"serial", "race"}),
        asset_role=None if "asset_role" not in table else _choice(table["asset_role"], "acquisition.asset_role", _ASSET_ROLES),
        timeout=None if "timeout" not in table else _positive_number(table["timeout"], "acquisition.timeout"),
        host_concurrency=None if "host_concurrency" not in table else _positive_int(table["host_concurrency"], "acquisition.host_concurrency"),
        host_min_interval=None if "host_min_interval" not in table else _nonnegative_number(table["host_min_interval"], "acquisition.host_min_interval"),
        forbidden_urls=None if "forbidden_urls" not in table else _config_path(table["forbidden_urls"], "acquisition.forbidden_urls", parent),
        preflight=preflight,
    )


def _parse_package(root: Mapping[str, Any]) -> PackageConfig:
    integer_fields = {
        "max_input_bytes", "max_pages", "max_structural_units", "max_depth",
        "max_elements", "max_text_characters", "summary_max_characters",
    }
    table = _table(root, "package", integer_fields | {"enrichment"})
    values: dict[str, Any] = {
        name: _positive_int(table[name], f"package.{name}")
        for name in integer_fields
        if name in table
    }
    if "enrichment" in table:
        if not isinstance(table["enrichment"], bool):
            raise _error("package.enrichment", "must be a boolean")
        values["enrichment"] = table["enrichment"]
    return PackageConfig(**values)


def _read_config_snapshot(config_path: Path) -> tuple[os.stat_result, bytes, Path]:
    try:
        before = config_path.lstat()
    except OSError as error:
        raise ConfigError(f"config file is not accessible: {config_path}") from error
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise ConfigError(f"config path must be a regular non-symlink file: {config_path}")
    try:
        canonical_path = config_path.resolve(strict=True)
    except OSError as error:
        raise ConfigError(f"config file is not accessible: {config_path}") from error
    canonical_parent = canonical_path.parent
    try:
        parent_before = canonical_parent.lstat()
    except OSError as error:
        raise ConfigError(f"config directory is not accessible: {canonical_parent}") from error
    if stat.S_ISLNK(parent_before.st_mode) or not stat.S_ISDIR(parent_before.st_mode):
        raise ConfigError(f"config directory must be a real directory: {canonical_parent}")
    flags = os.O_RDONLY
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(canonical_path, flags)
    except OSError as error:
        raise ConfigError(f"config file could not be opened safely: {config_path}") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ConfigError(f"config path must be a regular non-symlink file: {config_path}")
        if (before.st_dev, before.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise ConfigError(f"config file changed while opening: {config_path}")
        with os.fdopen(descriptor, "rb", closefd=True) as stream:
            descriptor = -1
            payload = stream.read(MAX_CONFIG_BYTES + 1)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if len(payload) > MAX_CONFIG_BYTES:
        raise ConfigError(f"config file exceeds {MAX_CONFIG_BYTES} bytes: {config_path}")
    try:
        parent_after = canonical_parent.lstat()
    except OSError as error:
        raise ConfigError(f"config directory changed while reading: {canonical_parent}") from error
    if (
        stat.S_ISLNK(parent_after.st_mode)
        or not stat.S_ISDIR(parent_after.st_mode)
        or (parent_before.st_dev, parent_before.st_ino)
        != (parent_after.st_dev, parent_after.st_ino)
    ):
        raise ConfigError(f"config directory changed while reading: {canonical_parent}")
    return metadata, payload, canonical_parent


def load_config(path: str | os.PathLike[str]) -> SciRetrieverConfig:
    """Load one strict config file without creating or modifying filesystem entries."""
    config_path = Path(path).expanduser()
    metadata, payload, parent = _read_config_snapshot(config_path)
    try:
        root = tomllib.load(BytesIO(payload))
    except tomllib.TOMLDecodeError as error:
        raise ConfigError(f"config file is not valid TOML: {config_path}") from error
    unknown = sorted(set(root) - _ROOT_KEYS)
    if unknown:
        raise ConfigError(f"unknown config field: {unknown[0]}")
    version = root.get("schema_version")
    if not isinstance(version, int) or isinstance(version, bool) or version != 1:
        raise _error("schema_version", "must be integer 1")
    credentials = _parse_credentials(root)
    if any(credentials.get(name) is not None for name in _CREDENTIAL_KEYS):
        if os.name == "posix" and metadata.st_mode & 0o077:
            raise ConfigError("config file containing credentials must have mode 0600 or stricter")
    return SciRetrieverConfig(
        schema_version=version,
        paths=_parse_paths(root, parent),
        credentials=credentials,
        discovery=_parse_discovery(root),
        search=_parse_search(root),
        acquisition=_parse_acquisition(root, parent),
        package=_parse_package(root),
    )


def resolve_storage_root(
    explicit: str | os.PathLike[str] | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> Path:
    """Resolve the configured storage root without touching the filesystem."""
    environ = os.environ if env is None else env
    configured = explicit if explicit is not None else environ.get(STORAGE_ROOT_ENV)
    if configured is None or not str(configured).strip():
        raise ConfigError(f"Storage root is required; pass it explicitly or set {STORAGE_ROOT_ENV}")
    return Path(configured).expanduser().resolve(strict=False)


def get_credential(env_var: str, *, env: Mapping[str, str] | None = None) -> str | None:
    """Read and normalize one credential from an environment mapping."""
    if not isinstance(env_var, str) or not env_var.strip():
        raise ConfigError("Credential environment variable name must be nonblank")
    environ = os.environ if env is None else env
    value = environ.get(env_var)
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


__all__ = (
    "CONFIG_ENV", "MAX_CONFIG_BYTES", "STORAGE_ROOT_ENV", "AcquisitionConfig",
    "ACQUISITION_PROVIDERS", "METADATA_PROVIDERS", "PreflightConfig",
    "CredentialsConfig", "DiscoveryConfig", "PackageConfig", "PathsConfig",
    "SciRetrieverConfig", "SearchConfig", "get_credential", "load_config", "resolve_storage_root",
)
