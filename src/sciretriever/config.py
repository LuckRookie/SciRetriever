"""Strict, side-effect-free access to SciRetriever configuration."""

from __future__ import annotations

import math
import ipaddress
import os
import re
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - exercised on Python 3.10
    import tomli as tomllib

from sciretriever.config_loader import MAX_CONFIG_BYTES, load_config
from sciretriever.config_models import (
    AcquisitionConfig,
    AnalysisConfig,
    BrowserConfig,
    BrowserRuleConfig,
    ConfigCheckMode,
    CredentialsConfig,
    CurationConfig,
    DiscoveryConfig,
    ExpansionConfig,
    ExportConfig,
    LLMConfig,
    MinerUConfig,
    PackageConfig,
    PathsConfig,
    PreflightConfig,
    SciHubConfig,
    SciRetrieverConfig,
    SearchConfig,
    TranslatorConfig,
    TranslatorRuleConfig,
)
from sciretriever.errors import ConfigError


STORAGE_ROOT_ENV = "SCIRETRIEVER_STORAGE_ROOT"
CONFIG_ENV = "SCIRETRIEVER_CONFIG"
_CREDENTIAL_KEYS = {
    "unpaywall_email",
    "semantic_scholar_api_key",
    "elsevier_api_key",
    "wiley_api_key",
    "springer_api_key",
}
TOML_LOAD = tomllib.load
TOML_DECODE_ERROR = tomllib.TOMLDecodeError
_DISCOVERY_SOURCES = {
    "crossref", "europe-pmc", "arxiv", "openalex", "semantic-scholar",
    "elsevier", "springer",
}
METADATA_PROVIDERS = frozenset(_DISCOVERY_SOURCES)
ACQUISITION_PROVIDERS = frozenset({
    "direct", "arxiv", "crossref", "unpaywall", "europe-pmc", "openalex",
    "semantic-scholar", "elsevier", "wiley", "springer", "sci-hub",
})


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


def _boolean(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise _error(name, "must be a boolean")
    return value


def _sci_hub_hostname(value: Any, name: str) -> str:
    hostname = _nonblank(value, name)
    if (
        hostname != hostname.lower()
        or hostname.startswith(".")
        or hostname.endswith(".")
        or "*" in hostname
        or re.fullmatch(
            r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?",
            hostname,
        ) is None
        or urlsplit(f"https://{hostname}").hostname != hostname
        or any(character in hostname for character in "/:@?#[]")
    ):
        raise _error(name, "must contain exact lowercase hostnames")
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        raise _error(name, "must contain exact lowercase hostnames")
    if hostname in {"localhost", "localhost.localdomain"} or hostname.endswith(".localhost"):
        raise _error(name, "must contain exact lowercase hostnames")
    return hostname


def _safe_doi_template(value: Any, name: str) -> tuple[str, str]:
    template = _nonblank(value, name)
    parsed = urlsplit(template)
    try:
        port = parsed.port
    except ValueError as error:
        raise _error(name, "must be a safe HTTPS template") from error
    braces = re.findall(r"\{[^{}]*\}", template)
    if (
        parsed.scheme != "https" or not parsed.hostname
        or parsed.netloc != parsed.netloc.lower()
        or parsed.username is not None or parsed.password is not None
        or parsed.fragment or port not in (None, 443)
        or any(character in parsed.netloc for character in "{}")
        or braces not in (["{doi}"], ["{doi_path}"])
        or template.count("{") != 1 or template.count("}") != 1
    ):
        raise _error(name, "must be a safe HTTPS template with exactly one supported DOI placeholder")
    return template, _sci_hub_hostname(parsed.hostname, name)


def _parse_browser(table: Mapping[str, Any], parent: Path) -> BrowserConfig:
    nested = _table(table, "browser", {
        "enabled", "profile_dir", "max_profile_bytes", "max_profile_files", "rules",
    })
    enabled = False if "enabled" not in nested else _boolean(
        nested["enabled"], "acquisition.browser.enabled"
    )
    profile = None if "profile_dir" not in nested else _config_path(
        nested["profile_dir"], "acquisition.browser.profile_dir", parent
    )
    max_bytes = 512 * 1024 * 1024 if "max_profile_bytes" not in nested else _positive_int(
        nested["max_profile_bytes"], "acquisition.browser.max_profile_bytes"
    )
    max_files = 20_000 if "max_profile_files" not in nested else _positive_int(
        nested["max_profile_files"], "acquisition.browser.max_profile_files"
    )
    if max_bytes > 4 * 1024 * 1024 * 1024:
        raise _error("acquisition.browser.max_profile_bytes", "exceeds the supported bound")
    if max_files > 100_000:
        raise _error("acquisition.browser.max_profile_files", "exceeds the supported bound")
    raw_rules = nested.get("rules", [])
    if not isinstance(raw_rules, list):
        raise _error("acquisition.browser.rules", "must be an array of tables")
    rules: list[BrowserRuleConfig] = []
    names: set[str] = set()
    required = {"name", "landing_url_template", "allowed_landing_hosts", "allowed_pdf_hosts", "allowed_network_hosts"}
    for index, raw_rule in enumerate(raw_rules):
        prefix = f"acquisition.browser.rules[{index}]"
        if not isinstance(raw_rule, dict):
            raise _error(prefix, "must be a table")
        unknown = sorted(set(raw_rule) - required)
        if unknown:
            raise ConfigError(f"unknown config field: {prefix}.{unknown[0]}")
        missing = sorted(required - set(raw_rule))
        if missing:
            raise _error(f"{prefix}.{missing[0]}", "is required")
        rule_name = _nonblank(raw_rule["name"], f"{prefix}.name")
        if re.fullmatch(r"[a-z][a-z0-9-]{0,31}", rule_name) is None:
            raise _error(f"{prefix}.name", "must be a bounded lowercase name")
        if rule_name in names:
            raise _error("acquisition.browser.rules", "must have unique names")
        names.add(rule_name)
        template, template_host = _safe_doi_template(
            raw_rule["landing_url_template"], f"{prefix}.landing_url_template"
        )
        def hosts(field_name: str) -> tuple[str, ...]:
            raw = raw_rule[field_name]
            if not isinstance(raw, list):
                raise _error(f"{prefix}.{field_name}", "must be a string list")
            result = tuple(_sci_hub_hostname(item, f"{prefix}.{field_name}") for item in raw)
            if len(set(result)) != len(result):
                raise _error(f"{prefix}.{field_name}", "must not contain duplicate values")
            return result
        landing = tuple(dict.fromkeys((template_host, *hosts("allowed_landing_hosts"))))
        pdf = hosts("allowed_pdf_hosts")
        network = tuple(dict.fromkeys((template_host, *hosts("allowed_network_hosts"), *pdf)))
        rules.append(BrowserRuleConfig(rule_name, template, landing, pdf, network))
    if enabled and profile is None:
        raise _error("acquisition.browser.profile_dir", "is required when enabled")
    if enabled and not rules:
        raise _error("acquisition.browser.rules", "must be nonempty when enabled")
    if not enabled and (profile is not None or rules):
        raise _error("acquisition.browser", "must not configure profile or rules when disabled")
    return BrowserConfig(enabled, profile, max_bytes, max_files, tuple(rules))


def _parse_translator(table: Mapping[str, Any]) -> TranslatorConfig:
    nested = _table(table, "translator", {"enabled", "rules"})
    enabled = False if "enabled" not in nested else _boolean(
        nested["enabled"], "acquisition.translator.enabled"
    )
    raw_rules = nested.get("rules", [])
    if not isinstance(raw_rules, list):
        raise _error("acquisition.translator.rules", "must be an array of tables")
    rules: list[TranslatorRuleConfig] = []
    names: set[str] = set()
    for index, raw_rule in enumerate(raw_rules):
        prefix = f"acquisition.translator.rules[{index}]"
        if not isinstance(raw_rule, dict):
            raise _error(prefix, "must be a table")
        unknown = sorted(set(raw_rule) - {
            "name", "landing_url_template", "allowed_landing_hosts", "allowed_pdf_hosts",
        })
        if unknown:
            raise ConfigError(f"unknown config field: {prefix}.{unknown[0]}")
        if set(raw_rule) < {"name", "landing_url_template"}:
            missing = "name" if "name" not in raw_rule else "landing_url_template"
            raise _error(f"{prefix}.{missing}", "is required")
        name = _nonblank(raw_rule["name"], f"{prefix}.name")
        if re.fullmatch(r"[a-z][a-z0-9-]{0,31}", name) is None:
            raise _error(f"{prefix}.name", "must be a bounded lowercase name")
        if name in names:
            raise _error("acquisition.translator.rules", "must have unique names")
        names.add(name)
        template = _nonblank(raw_rule["landing_url_template"], f"{prefix}.landing_url_template")
        parsed = urlsplit(template)
        try:
            port = parsed.port
        except ValueError as error:
            raise _error(f"{prefix}.landing_url_template", "must be a safe HTTPS template") from error
        braces = re.findall(r"\{[^{}]*\}", template)
        if (
            parsed.scheme != "https" or not parsed.hostname
            or parsed.netloc != parsed.netloc.lower()
            or parsed.username is not None or parsed.password is not None
            or parsed.fragment or port not in (None, 443)
            or any(character in parsed.netloc for character in "{}")
            or braces not in (["{doi}"], ["{doi_path}"])
            or template.count("{") != 1 or template.count("}") != 1
        ):
            raise _error(f"{prefix}.landing_url_template", "must be a safe HTTPS template with exactly one supported DOI placeholder")
        def hosts(field_name: str) -> tuple[str, ...]:
            raw = raw_rule.get(field_name, [])
            if not isinstance(raw, list):
                raise _error(f"{prefix}.{field_name}", "must be a string list")
            result = tuple(_sci_hub_hostname(item, f"{prefix}.{field_name}") for item in raw)
            if len(set(result)) != len(result):
                raise _error(f"{prefix}.{field_name}", "must not contain duplicate values")
            return result
        rules.append(TranslatorRuleConfig(
            name, template, hosts("allowed_landing_hosts"), hosts("allowed_pdf_hosts")
        ))
    if enabled and not rules:
        raise _error("acquisition.translator.rules", "must be nonempty when enabled")
    if not enabled and rules:
        raise _error("acquisition.translator.rules", "must be empty when disabled")
    return TranslatorConfig(enabled, tuple(rules))


def _sci_hub_base_url(value: Any) -> str:
    base_url = _nonblank(value, "acquisition.sci_hub.base_url")
    parsed = urlsplit(base_url)
    try:
        port = parsed.port
    except ValueError as error:
        raise _error("acquisition.sci_hub.base_url", "must be an authorized HTTPS URL") from error
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or port not in (None, 443)
    ):
        raise _error("acquisition.sci_hub.base_url", "must be an authorized HTTPS URL")
    return base_url


def _parse_sci_hub(table: Mapping[str, Any], providers: tuple[str, ...] | None) -> SciHubConfig:
    nested = _table(table, "sci_hub", {"enabled", "base_url", "allowed_pdf_hosts"})
    enabled = False if "enabled" not in nested else _boolean(
        nested["enabled"], "acquisition.sci_hub.enabled"
    )
    base_url = None if "base_url" not in nested else _sci_hub_base_url(nested["base_url"])
    allowed_hosts: tuple[str, ...] = ()
    if "allowed_pdf_hosts" in nested:
        raw_hosts = nested["allowed_pdf_hosts"]
        if not isinstance(raw_hosts, list):
            raise _error("acquisition.sci_hub.allowed_pdf_hosts", "must be a string list")
        allowed_hosts = tuple(
            _sci_hub_hostname(item, "acquisition.sci_hub.allowed_pdf_hosts")
            for item in raw_hosts
        )
        if len(set(allowed_hosts)) != len(allowed_hosts):
            raise _error("acquisition.sci_hub.allowed_pdf_hosts", "must not contain duplicate values")
    selected = providers is not None and "sci-hub" in providers
    if selected != enabled:
        raise _error(
            "acquisition.sci_hub.enabled",
            "must be true exactly when sci-hub is listed in acquisition.providers",
        )
    if enabled and base_url is None:
        raise _error("acquisition.sci_hub.base_url", "is required when enabled")
    return SciHubConfig(enabled, base_url, allowed_hosts)


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
        level=None if "level" not in table else _choice(
            table["level"], "search.level", {"metadata", "download", "analyze"}
        ),
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
    allowed = {
        "providers", "timeout", "provider_concurrency", "host_concurrency",
        "host_min_interval", "max_asset_bytes", "forbidden_urls", "include_xml",
        "include_html", "preflight", "sci_hub", "translator", "browser",
    }
    table = _table(root, "acquisition", allowed)
    providers = None
    if "providers" in table:
        providers = _string_list(table["providers"], "acquisition.providers", nonempty=True)
        if any(provider not in ACQUISITION_PROVIDERS for provider in providers):
            raise _error("acquisition.providers", "contains an unsupported provider")
    sci_hub = _parse_sci_hub(table, providers)
    translator = _parse_translator(table)
    browser = _parse_browser(table, parent)
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
        timeout=None if "timeout" not in table else _positive_number(table["timeout"], "acquisition.timeout"),
        provider_concurrency=None if "provider_concurrency" not in table else _positive_int(table["provider_concurrency"], "acquisition.provider_concurrency"),
        host_concurrency=None if "host_concurrency" not in table else _positive_int(table["host_concurrency"], "acquisition.host_concurrency"),
        host_min_interval=None if "host_min_interval" not in table else _nonnegative_number(table["host_min_interval"], "acquisition.host_min_interval"),
        max_asset_bytes=None if "max_asset_bytes" not in table else _positive_int(table["max_asset_bytes"], "acquisition.max_asset_bytes"),
        forbidden_urls=None if "forbidden_urls" not in table else _config_path(table["forbidden_urls"], "acquisition.forbidden_urls", parent),
        include_xml=None if "include_xml" not in table else _boolean(table["include_xml"], "acquisition.include_xml"),
        include_html=None if "include_html" not in table else _boolean(table["include_html"], "acquisition.include_html"),
        preflight=preflight,
        sci_hub=sci_hub,
        translator=translator,
        browser=browser,
    )


def _parse_package(root: Mapping[str, Any]) -> PackageConfig:
    integer_fields = {
        "max_input_bytes", "max_pages", "max_structural_units", "max_depth",
        "max_elements", "max_text_characters",
    }
    table = _table(root, "package", integer_fields)
    values: dict[str, Any] = {
        name: _positive_int(table[name], f"package.{name}")
        for name in integer_fields
        if name in table
    }
    return PackageConfig(**values)


def _env_name(value: Any, name: str) -> str:
    parsed = _nonblank(value, name)
    if re.fullmatch(r"[A-Z_][A-Z0-9_]{0,127}", parsed) is None:
        raise _error(name, "must be an environment variable name")
    return parsed


def _fixed_origin(value: Any, name: str, *, loopback: bool) -> str:
    endpoint = _nonblank(value, name)
    parsed = urlsplit(endpoint)
    try:
        port = parsed.port
    except ValueError as error:
        raise _error(name, "must be a fixed-origin endpoint") from error
    if parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment or not parsed.hostname:
        raise _error(name, "must be a fixed-origin endpoint")
    try:
        address = ipaddress.ip_address(parsed.hostname)
        is_loopback = address.is_loopback
    except ValueError:
        is_loopback = parsed.hostname == "localhost"
    if loopback:
        if parsed.scheme != "http" or not is_loopback:
            raise _error(name, "must be explicit loopback HTTP in loopback mode")
    elif parsed.scheme != "https" or is_loopback or port not in (None, 443):
        raise _error(name, "must be remote HTTPS on the default port")
    if parsed.path not in ("", "/"):
        raise _error(name, "must contain only an origin")
    return endpoint.rstrip("/")


def _https_base_url(value: Any, name: str) -> str:
    endpoint = _nonblank(value, name)
    if any(ord(character) < 33 or ord(character) == 127 for character in endpoint) or "\\" in endpoint:
        raise _error(name, "must be a safe remote HTTPS base URL")
    parsed = urlsplit(endpoint)
    try:
        port = parsed.port
    except ValueError as error:
        raise _error(name, "must be a safe remote HTTPS base URL") from error
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment
            or port not in (None, 443)):
        raise _error(name, "must be a safe remote HTTPS base URL")
    try:
        ipaddress.ip_address(parsed.hostname)
    except ValueError:
        is_loopback = parsed.hostname == "localhost"
    else:
        raise _error(name, "must use a DNS hostname, not an IP literal")
    segments = parsed.path.split("/")
    lowered_path = parsed.path.lower()
    if (is_loopback or "" in segments[1:-1]
            or any(segment in {".", ".."} for segment in segments)
            or any(encoded in lowered_path for encoded in ("%2e", "%2f", "%5c"))):
        raise _error(name, "must be a safe remote HTTPS base URL")
    path = parsed.path.rstrip("/")
    return f"https://{parsed.hostname.lower()}{path}"


def _bounded_positive(table: Mapping[str, Any], name: str, prefix: str, default: int, maximum: int) -> int:
    value = default if name not in table else _positive_int(table[name], f"{prefix}.{name}")
    if value > maximum:
        raise _error(f"{prefix}.{name}", "exceeds the supported bound")
    return value


def _parse_analysis(root: Mapping[str, Any]) -> AnalysisConfig:
    analysis = _table(root, "analysis", {"mineru", "llm"})
    mineru_table = _table(analysis, "mineru", {
        "mode", "endpoint", "auth_env", "remote_upload", "service_version", "api_protocol",
        "backend", "model", "overall_deadline", "poll_interval", "max_archive_bytes",
        "max_json_bytes", "max_pages", "max_blocks", "max_spans", "max_text_characters", "max_image_bytes",
        "max_archive_files", "max_extracted_bytes", "max_file_bytes",
        "max_compression_ratio", "max_images", "max_json_depth",
        "max_json_elements", "max_json_string_characters",
        "max_upload_bytes", "max_attempts",
    })
    mode = "disabled" if "mode" not in mineru_table else _choice(mineru_table["mode"], "analysis.mineru.mode", {"disabled", "loopback", "remote"})
    endpoint = None if "endpoint" not in mineru_table else _fixed_origin(mineru_table["endpoint"], "analysis.mineru.endpoint", loopback=mode == "loopback")
    auth_env = None if "auth_env" not in mineru_table else _env_name(mineru_table["auth_env"], "analysis.mineru.auth_env")
    remote_upload = False if "remote_upload" not in mineru_table else _boolean(mineru_table["remote_upload"], "analysis.mineru.remote_upload")
    service_version = str(mineru_table.get("service_version", "3.4.4"))
    api_protocol = mineru_table.get("api_protocol", 2)
    backend = str(mineru_table.get("backend", "vlm-engine"))
    model = _optional_string(mineru_table, "model", "analysis.mineru")
    if service_version != "3.4.4" or api_protocol != 2 or isinstance(api_protocol, bool) or backend != "vlm-engine":
        raise _error("analysis.mineru", "must pin service_version 3.4.4, api_protocol 2, and backend vlm-engine")
    if mode == "disabled" and (endpoint is not None or auth_env is not None or remote_upload or model is not None):
        raise _error("analysis.mineru", "must not configure a disabled target")
    if mode in {"loopback", "remote"} and (endpoint is None or model is None):
        raise _error("analysis.mineru", "requires endpoint and model when enabled")
    if mode == "loopback" and (auth_env is not None or remote_upload):
        raise _error("analysis.mineru", "loopback mode forbids auth_env and remote_upload")
    if mode == "remote" and (auth_env is None or not remote_upload):
        raise _error("analysis.mineru", "remote mode requires auth_env and remote_upload=true")
    mineru = MinerUConfig(
        mode, endpoint, auth_env, remote_upload, service_version, 2, backend, model,
        900.0 if "overall_deadline" not in mineru_table else _positive_number(mineru_table["overall_deadline"], "analysis.mineru.overall_deadline"),
        2.0 if "poll_interval" not in mineru_table else _positive_number(mineru_table["poll_interval"], "analysis.mineru.poll_interval"),
        _bounded_positive(mineru_table, "max_archive_bytes", "analysis.mineru", 512 * 1024 * 1024, 2 * 1024 * 1024 * 1024),
        _bounded_positive(mineru_table, "max_json_bytes", "analysis.mineru", 128 * 1024 * 1024, 512 * 1024 * 1024),
        _bounded_positive(mineru_table, "max_pages", "analysis.mineru", 2000, 10_000),
        _bounded_positive(mineru_table, "max_blocks", "analysis.mineru", 500_000, 2_000_000),
        _bounded_positive(mineru_table, "max_spans", "analysis.mineru", 2_000_000, 10_000_000),
        _bounded_positive(mineru_table, "max_text_characters", "analysis.mineru", 100_000_000, 500_000_000),
        _bounded_positive(mineru_table, "max_image_bytes", "analysis.mineru", 64 * 1024 * 1024, 256 * 1024 * 1024),
        _bounded_positive(mineru_table, "max_archive_files", "analysis.mineru", 10_000, 100_000),
        _bounded_positive(mineru_table, "max_extracted_bytes", "analysis.mineru", 1024 * 1024 * 1024, 4 * 1024 * 1024 * 1024),
        _bounded_positive(mineru_table, "max_file_bytes", "analysis.mineru", 256 * 1024 * 1024, 1024 * 1024 * 1024),
        _bounded_positive(mineru_table, "max_compression_ratio", "analysis.mineru", 200, 1000),
        _bounded_positive(mineru_table, "max_images", "analysis.mineru", 5000, 50_000),
        _bounded_positive(mineru_table, "max_json_depth", "analysis.mineru", 100, 500),
        _bounded_positive(mineru_table, "max_json_elements", "analysis.mineru", 2_000_000, 10_000_000),
        _bounded_positive(mineru_table, "max_json_string_characters", "analysis.mineru", 100_000_000, 500_000_000),
        _bounded_positive(mineru_table, "max_upload_bytes", "analysis.mineru", 100 * 1024 * 1024, 1024 * 1024 * 1024),
        _bounded_positive(mineru_table, "max_attempts", "analysis.mineru", 3, 100),
    )
    if mineru.max_file_bytes > mineru.max_extracted_bytes:
        raise _error("analysis.mineru.max_file_bytes", "must not exceed max_extracted_bytes")
    if mineru.poll_interval > mineru.overall_deadline:
        raise _error("analysis.mineru.poll_interval", "must not exceed overall_deadline")
    llm_table = _table(analysis, "llm", {"endpoint", "model", "credential_env", "timeout", "max_output_tokens",
                                                   "max_input_characters", "max_source_units"})
    llm_endpoint = None if "endpoint" not in llm_table else _https_base_url(llm_table["endpoint"], "analysis.llm.endpoint")
    llm_model = _optional_string(llm_table, "model", "analysis.llm")
    credential_env = None if "credential_env" not in llm_table else _env_name(llm_table["credential_env"], "analysis.llm.credential_env")
    configured = bool(llm_table)
    if configured and (llm_endpoint is None or llm_model is None or credential_env is None):
        raise _error("analysis.llm", "requires endpoint, model, and credential_env")
    llm = LLMConfig(
        llm_endpoint, llm_model, credential_env,
        120.0 if "timeout" not in llm_table else _positive_number(llm_table["timeout"], "analysis.llm.timeout"),
        _bounded_positive(llm_table, "max_output_tokens", "analysis.llm", 16_384, 131_072),
        _bounded_positive(llm_table, "max_input_characters", "analysis.llm", 200_000, 2_000_000),
        _bounded_positive(llm_table, "max_source_units", "analysis.llm", 5_000, 100_000),
    )
    if llm.timeout > 600:
        raise _error("analysis.llm.timeout", "exceeds the supported bound")
    return AnalysisConfig(mineru, llm)


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
    "ConfigCheckMode", "CredentialsConfig", "CurationConfig", "DiscoveryConfig",
    "ExpansionConfig", "ExportConfig", "AnalysisConfig", "MinerUConfig", "LLMConfig", "PackageConfig", "PathsConfig", "SciHubConfig",
    "TranslatorConfig", "TranslatorRuleConfig", "BrowserConfig", "BrowserRuleConfig",
    "SciRetrieverConfig", "SearchConfig", "get_credential", "load_config", "resolve_storage_root",
)
