from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

from sciretriever.config_models import CurationConfig, ExpansionConfig, ExportConfig
from sciretriever.errors import ConfigError


def _table(root: Mapping[str, Any], name: str, allowed: set[str]) -> Mapping[str, Any]:
    value = root.get(name, {})
    if not isinstance(value, dict):
        raise ConfigError(f"config field {name} must be a table")
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ConfigError(f"unknown config field: {name}.{unknown[0]}")
    return value


def _choice(value: Any, name: str, choices: set[str]) -> str:
    if not isinstance(value, str) or value not in choices:
        raise ConfigError(f"config field {name} has an unsupported value")
    return value


def _nonnegative_int(value: Any, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ConfigError(f"config field {name} must be a nonnegative integer")
    return value


def parse_wp6_sections(
    root: Mapping[str, Any],
) -> tuple[ExpansionConfig, CurationConfig, ExportConfig, float]:
    expansion_table = _table(
        root, "expansion",
        {"direction", "depth", "providers", "max_provider_calls", "page_size"},
    )
    curation_table = _table(root, "curation", {"output_format"})
    export_table = _table(root, "export", {"output_format", "include_references"})
    expansion = ExpansionConfig(
        direction="references" if "direction" not in expansion_table else _choice(
            expansion_table["direction"], "expansion.direction", {"references", "cited-by", "both"}
        ),
        depth=0 if "depth" not in expansion_table else _nonnegative_int(
            expansion_table["depth"], "expansion.depth"
        ),
        providers=_providers(expansion_table.get("providers", ["openalex", "semantic-scholar"])),
        max_provider_calls=_positive_int(
            expansion_table.get("max_provider_calls", 10), "expansion.max_provider_calls"
        ),
        page_size=_page_size(expansion_table.get("page_size", 100)),
    )
    curation = CurationConfig(
        output_format="json" if "output_format" not in curation_table else _choice(
            curation_table["output_format"], "curation.output_format", {"json", "jsonl"}
        )
    )
    output_format = "jsonl" if "output_format" not in export_table else _choice(
        export_table["output_format"], "export.output_format", {"json", "jsonl"}
    )
    references = export_table.get("include_references", False)
    if not isinstance(references, bool):
        raise ConfigError("config field export.include_references must be a boolean")
    interval_value = root.get("document_start_interval_seconds", 30.0)
    if (
        not isinstance(interval_value, (int, float))
        or isinstance(interval_value, bool)
        or not math.isfinite(float(interval_value))
        or not 0 < float(interval_value) <= 86_400
    ):
        raise ConfigError(
            "config field document_start_interval_seconds must be a positive finite number not exceeding 86400"
        )
    return expansion, curation, ExportConfig(output_format, references), float(interval_value)


def _positive_int(value: Any, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ConfigError(f"config field {name} must be a positive integer")
    return value


def _page_size(value: Any) -> int:
    parsed = _positive_int(value, "expansion.page_size")
    if parsed > 200:
        raise ConfigError("config field expansion.page_size must not exceed 200")
    return parsed


def _providers(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list) or not value or not all(isinstance(item, str) for item in value):
        raise ConfigError("config field expansion.providers must be a nonempty string array")
    providers = tuple(value)
    supported = {"openalex", "semantic-scholar"}
    if len(set(providers)) != len(providers):
        raise ConfigError("config field expansion.providers must not contain duplicates")
    if any(provider not in supported for provider in providers):
        raise ConfigError("config field expansion.providers contains an unsupported provider")
    return providers


__all__ = ("parse_wp6_sections",)
