from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any, Final

from sciretriever.config_models import (
    CredentialsConfig,
    DiscoveryConfig,
    PackageConfig,
    PathsConfig,
    SearchConfig,
)

from .common import (
    choice,
    config_error,
    config_path,
    nonblank,
    optional_string,
    positive_int,
    positive_number,
    string_list,
    table,
)


CREDENTIAL_KEYS: Final = frozenset({
    "unpaywall_email",
    "semantic_scholar_api_key",
    "elsevier_api_key",
    "wiley_api_key",
    "springer_api_key",
})
DISCOVERY_SOURCES: Final = frozenset({
    "crossref", "europe-pmc", "arxiv", "openalex", "semantic-scholar",
    "elsevier", "springer",
})
METADATA_PROVIDERS: Final = DISCOVERY_SOURCES


def parse_paths(root: Mapping[str, Any], parent: Path) -> PathsConfig:
    section = table(root, "paths", {"catalog", "storage_root"})
    return PathsConfig(
        catalog=None if "catalog" not in section else config_path(
            section["catalog"], "paths.catalog", parent
        ),
        storage_root=None if "storage_root" not in section else config_path(
            section["storage_root"], "paths.storage_root", parent
        ),
    )


def parse_credentials(root: Mapping[str, Any]) -> CredentialsConfig:
    section = table(root, "credentials", set(CREDENTIAL_KEYS))
    values = {
        name: nonblank(section[name], f"credentials.{name}", credential=True)
        for name in CREDENTIAL_KEYS
        if name in section
    }
    return CredentialsConfig(**values)


def parse_discovery(root: Mapping[str, Any]) -> DiscoveryConfig:
    allowed = {
        "sources", "limit", "timeout", "taxonomy", "taxonomy_version",
        "crossref_mailto", "filters", "label_rules",
    }
    section = table(root, "discovery", allowed)
    sources = None
    if "sources" in section:
        sources = string_list(section["sources"], "discovery.sources", nonempty=True)
        if any(source not in DISCOVERY_SOURCES for source in sources):
            raise config_error("discovery.sources", "contains an unsupported source")
    filters = _parse_year_filters(section, "discovery")

    raw_rules = section.get("label_rules", {})
    rules_table = table(
        section,
        "label_rules",
        set(raw_rules) if isinstance(raw_rules, dict) else set(),
    )
    rules = tuple(
        (label, string_list(terms, f"discovery.label_rules.{label}", nonempty=True))
        for label, terms in rules_table.items()
        if nonblank(label, "discovery.label_rules label")
    )
    return DiscoveryConfig(
        sources=sources,
        limit=None if "limit" not in section else positive_int(
            section["limit"], "discovery.limit"
        ),
        timeout=None if "timeout" not in section else positive_number(
            section["timeout"], "discovery.timeout"
        ),
        taxonomy=optional_string(section, "taxonomy", "discovery"),
        taxonomy_version=optional_string(section, "taxonomy_version", "discovery"),
        crossref_mailto=optional_string(section, "crossref_mailto", "discovery"),
        filters=filters,
        label_rules=rules,
    )


def _parse_year_filters(
    section: Mapping[str, Any],
    section_name: str,
) -> tuple[tuple[str, str], ...]:
    filters_table = table(section, "filters", {"year_from", "year_to"})
    filters: list[tuple[str, str]] = []
    for name in ("year_from", "year_to"):
        if name in filters_table:
            path = f"{section_name}.filters.{name}"
            year = positive_int(filters_table[name], path)
            if year > 9999:
                raise config_error(path, "must be a year from 1 through 9999")
            filters.append((name, str(year)))
    if len(filters) == 2 and int(filters[0][1]) > int(filters[1][1]):
        raise config_error(
            f"{section_name}.filters.year_from", "must not be later than year_to"
        )
    return tuple(filters)


def parse_search(root: Mapping[str, Any]) -> SearchConfig:
    allowed = {
        "level", "limit", "completion_limit", "providers", "precedence", "provider_timeout",
        "max_concurrency", "crossref_mailto", "filters",
    }
    section = table(root, "search", allowed)
    has_providers = "providers" in section
    has_precedence = "precedence" in section
    if has_providers != has_precedence:
        raise config_error("search", "must define providers and precedence together")
    providers = None
    precedence = None
    if has_providers:
        providers = string_list(section["providers"], "search.providers", nonempty=True)
        precedence = string_list(
            section["precedence"], "search.precedence", nonempty=True
        )
        if any(provider not in METADATA_PROVIDERS for provider in providers):
            raise config_error("search.providers", "contains an unsupported provider")
        if any(provider not in METADATA_PROVIDERS for provider in precedence):
            raise config_error("search.precedence", "contains an unsupported provider")
        if set(precedence) != set(providers):
            raise config_error(
                "search.precedence", "must contain every configured provider exactly once"
            )
    return SearchConfig(
        level=None if "level" not in section else choice(
            section["level"], "search.level", {"metadata", "download", "analyze"}
        ),
        limit=None if "limit" not in section else positive_int(
            section["limit"], "search.limit"
        ),
        completion_limit=None if "completion_limit" not in section else positive_int(
            section["completion_limit"], "search.completion_limit"
        ),
        providers=providers,
        precedence=precedence,
        provider_timeout=None if "provider_timeout" not in section else positive_number(
            section["provider_timeout"], "search.provider_timeout"
        ),
        max_concurrency=None if "max_concurrency" not in section else positive_int(
            section["max_concurrency"], "search.max_concurrency"
        ),
        crossref_mailto=optional_string(section, "crossref_mailto", "search"),
        filters=_parse_year_filters(section, "search"),
    )


def parse_package(root: Mapping[str, Any]) -> PackageConfig:
    integer_fields = {
        "max_input_bytes", "max_pages", "max_structural_units", "max_depth",
        "max_elements", "max_text_characters",
    }
    section = table(root, "package", integer_fields)
    values = {
        name: positive_int(section[name], f"package.{name}")
        for name in integer_fields
        if name in section
    }
    return PackageConfig(**values)


__all__ = (
    "CREDENTIAL_KEYS",
    "DISCOVERY_SOURCES",
    "METADATA_PROVIDERS",
    "parse_credentials",
    "parse_discovery",
    "parse_package",
    "parse_paths",
    "parse_search",
)
