from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any, Final

from sciretriever.config_models import AcquisitionConfig, PreflightConfig

from .acquisition_rules import parse_browser, parse_sci_hub, parse_translator
from .common import (
    boolean,
    choice,
    config_error,
    config_path,
    nonnegative_int,
    nonnegative_number,
    positive_int,
    positive_number,
    string_list,
    table,
)


ACQUISITION_PROVIDERS: Final = frozenset({
    "direct", "arxiv", "crossref", "unpaywall", "europe-pmc", "openalex",
    "semantic-scholar", "elsevier", "wiley", "springer", "sci-hub",
})


def parse_acquisition(root: Mapping[str, Any], parent: Path) -> AcquisitionConfig:
    allowed = {
        "providers", "timeout", "provider_concurrency", "host_concurrency",
        "host_min_interval", "max_asset_bytes", "forbidden_urls", "include_xml",
        "include_html", "preflight", "sci_hub", "translator", "browser",
    }
    section = table(root, "acquisition", allowed)
    providers = None
    if "providers" in section:
        providers = string_list(
            section["providers"], "acquisition.providers", nonempty=True
        )
        if any(provider not in ACQUISITION_PROVIDERS for provider in providers):
            raise config_error(
                "acquisition.providers", "contains an unsupported provider"
            )
    preflight_table = table(
        section, "preflight", {"min_free_bytes", "max_asset_bytes", "readiness", "timeout"}
    )
    preflight = PreflightConfig(
        min_free_bytes=1024 * 1024 * 1024 if "min_free_bytes" not in preflight_table else nonnegative_int(
            preflight_table["min_free_bytes"], "acquisition.preflight.min_free_bytes"
        ),
        max_asset_bytes=100 * 1024 * 1024 if "max_asset_bytes" not in preflight_table else positive_int(
            preflight_table["max_asset_bytes"], "acquisition.preflight.max_asset_bytes"
        ),
        readiness="none" if "readiness" not in preflight_table else choice(
            preflight_table["readiness"],
            "acquisition.preflight.readiness",
            {"none", "headers"},
        ),
        timeout=10.0 if "timeout" not in preflight_table else positive_number(
            preflight_table["timeout"], "acquisition.preflight.timeout"
        ),
    )
    if preflight.min_free_bytes < preflight.max_asset_bytes:
        raise config_error(
            "acquisition.preflight.min_free_bytes", "must be at least max_asset_bytes"
        )
    return AcquisitionConfig(
        providers=providers,
        timeout=None if "timeout" not in section else positive_number(
            section["timeout"], "acquisition.timeout"
        ),
        provider_concurrency=None if "provider_concurrency" not in section else positive_int(
            section["provider_concurrency"], "acquisition.provider_concurrency"
        ),
        host_concurrency=None if "host_concurrency" not in section else positive_int(
            section["host_concurrency"], "acquisition.host_concurrency"
        ),
        host_min_interval=None if "host_min_interval" not in section else nonnegative_number(
            section["host_min_interval"], "acquisition.host_min_interval"
        ),
        max_asset_bytes=None if "max_asset_bytes" not in section else positive_int(
            section["max_asset_bytes"], "acquisition.max_asset_bytes"
        ),
        forbidden_urls=None if "forbidden_urls" not in section else config_path(
            section["forbidden_urls"], "acquisition.forbidden_urls", parent
        ),
        include_xml=None if "include_xml" not in section else boolean(
            section["include_xml"], "acquisition.include_xml"
        ),
        include_html=None if "include_html" not in section else boolean(
            section["include_html"], "acquisition.include_html"
        ),
        preflight=preflight,
        sci_hub=parse_sci_hub(section, providers),
        translator=parse_translator(section),
        browser=parse_browser(section, parent),
    )


__all__ = ("ACQUISITION_PROVIDERS", "parse_acquisition")
