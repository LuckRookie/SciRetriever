from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

from sciretriever.config_models import ExpansionConfig
from sciretriever.errors import ConfigError

from .common import choice, config_error, nonnegative_int, positive_int, table


def parse_expansion(root: Mapping[str, Any]) -> ExpansionConfig:
    section = table(
        root,
        "expansion",
        {"direction", "depth", "providers", "max_provider_calls", "page_size"},
    )
    return ExpansionConfig(
        direction="references" if "direction" not in section else choice(
            section["direction"],
            "expansion.direction",
            {"references", "cited-by", "both"},
        ),
        depth=0 if "depth" not in section else nonnegative_int(
            section["depth"], "expansion.depth"
        ),
        providers=_providers(section.get("providers", ["openalex", "semantic-scholar"])),
        max_provider_calls=positive_int(
            section.get("max_provider_calls", 10), "expansion.max_provider_calls"
        ),
        page_size=_page_size(section.get("page_size", 100)),
    )


def parse_document_start_interval(root: Mapping[str, Any]) -> float:
    value = root.get("document_start_interval_seconds", 30.0)
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(float(value))
        or not 0 < float(value) <= 86_400
    ):
        raise ConfigError(
            "config field document_start_interval_seconds must be a positive "
            "finite number not exceeding 86400"
        )
    return float(value)


def _page_size(value: Any) -> int:
    parsed = positive_int(value, "expansion.page_size")
    if parsed > 200:
        raise config_error("expansion.page_size", "must not exceed 200")
    return parsed


def _providers(value: Any) -> tuple[str, ...]:
    if (
        not isinstance(value, list)
        or not value
        or not all(isinstance(item, str) for item in value)
    ):
        raise config_error("expansion.providers", "must be a nonempty string array")
    providers = tuple(value)
    supported = {"openalex", "semantic-scholar"}
    if len(set(providers)) != len(providers):
        raise config_error("expansion.providers", "must not contain duplicates")
    if any(provider not in supported for provider in providers):
        raise config_error("expansion.providers", "contains an unsupported provider")
    return providers


__all__ = ("parse_document_start_interval", "parse_expansion")
