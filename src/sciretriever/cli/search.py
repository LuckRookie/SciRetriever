"""Argument parsing and runtime assembly for metadata search."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
from pathlib import Path
import sys

from sciretriever.catalog import canonical_json
from sciretriever.cli.acquisition_runtime import (
    DEFAULT_ACQUISITION_PROVIDERS, MAX_RESPONSE_BYTES, AcquisitionCliConfig,
)
from sciretriever.cli.analysis_runtime import AnalysisCliRuntime
from sciretriever.cli.metadata_runtime import (
    ALL_METADATA_PROVIDERS, DEFAULT_METADATA_PROVIDERS, MetadataCliConfig,
    MetadataSearchOutput,
)
from .search_completion_runtime import (
    SearchCliRuntime,
    build_search_completion_runtime,
)
from sciretriever.completion import (
    BatchItemStatus, CompletionStop, DoiTarget, OptionalAssetKind, OptionalAssetRequest,
    WorkVersionTarget, run_completion_batch,
)
from sciretriever.config import (
    ACQUISITION_PROVIDERS, AnalysisConfig, BrowserConfig, CredentialsConfig,
    SciHubConfig, TranslatorConfig,
)
from sciretriever.errors import SciRetrieverError, SearchError
from sciretriever.core.public_identifiers import PUBLIC_IDENTIFIER_NAMESPACES


DEFAULT_PROVIDERS = DEFAULT_METADATA_PROVIDERS
ALL_PROVIDERS = ALL_METADATA_PROVIDERS
DEFAULT_SEARCH_LIMIT = 100
DEFAULT_PROVIDER_TIMEOUT_SECONDS = 30.0
DEFAULT_MAX_CONCURRENCY = 8


def _nonblank(value: str) -> str:
    normalized = " ".join(value.split())
    if not normalized:
        raise argparse.ArgumentTypeError("value must not be blank")
    return normalized


def _positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive integer") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _positive_float(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive number") from error
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive number")
    return parsed


def configure_parser(parser: argparse.ArgumentParser) -> None:
    """Configure the implemented metadata-only ``search`` command."""
    parser.description = "Search metadata providers and persist canonical Works."
    parser.add_argument("query", type=_nonblank, metavar="QUERY")
    parser.add_argument("--catalog", required=True, type=Path, metavar="PATH")
    parser.add_argument("--level", choices=("metadata", "download", "analyze"), default="metadata")
    parser.add_argument("--provider", action="append", choices=ALL_PROVIDERS)
    parser.add_argument("--precedence", action="append", choices=ALL_PROVIDERS)
    parser.add_argument("--limit", type=_positive_int, default=DEFAULT_SEARCH_LIMIT)
    parser.add_argument(
        "--provider-timeout",
        type=_positive_float,
        default=DEFAULT_PROVIDER_TIMEOUT_SECONDS,
    )
    parser.add_argument(
        "--max-concurrency", type=_positive_int, default=DEFAULT_MAX_CONCURRENCY
    )
    parser.add_argument("--crossref-mailto", type=_nonblank, metavar="EMAIL")
    parser.add_argument("--storage-root", type=Path)
    parser.add_argument("--download-provider", action="append", choices=tuple(sorted(ACQUISITION_PROVIDERS)))
    parser.add_argument("--download-timeout", type=_positive_float, default=30.0)
    parser.add_argument("--download-provider-concurrency", type=_positive_int, default=4)
    parser.add_argument("--host-concurrency", type=_positive_int, default=2)
    parser.add_argument("--host-min-interval", type=float, default=0.0)
    parser.add_argument("--max-asset-bytes", type=_positive_int, default=MAX_RESPONSE_BYTES)
    parser.add_argument("--forbidden-urls", type=Path)
    parser.add_argument("--xml", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--html", action=argparse.BooleanOptionalAction, default=False)


def validate_arguments(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    """Validate repeated provider selections and establish deterministic defaults."""
    providers = list(args.provider or DEFAULT_PROVIDERS)
    precedence = list(args.precedence or providers)
    duplicate_providers = sorted({name for name in providers if providers.count(name) > 1})
    duplicate_precedence = sorted({name for name in precedence if precedence.count(name) > 1})
    if duplicate_providers:
        parser.error(f"duplicate provider: {', '.join(duplicate_providers)}")
    if duplicate_precedence:
        parser.error(f"duplicate precedence: {', '.join(duplicate_precedence)}")
    if len(precedence) != len(providers) or set(precedence) != set(providers):
        parser.error("precedence must contain every selected provider exactly once")
    args.provider = providers
    args.precedence = precedence
    if args.level in {"download", "analyze"} and args.storage_root is None:
        parser.error(f"search --level {args.level} requires --storage-root")
    if args.level == "analyze":
        config = getattr(args, "_config_analysis", None)
        if (config is None or config.mineru.mode == "disabled" or config.llm.endpoint is None
                or config.llm.model is None or config.llm.credential_env is None):
            parser.error("search --level analyze requires fully enabled analysis config")
    if args.host_min_interval < 0:
        parser.error("--host-min-interval must be nonnegative")
    download_providers = list(args.download_provider or DEFAULT_ACQUISITION_PROVIDERS)
    if len(download_providers) != len(set(download_providers)):
        parser.error("duplicate download provider")
    args.download_provider = download_providers
    sci_hub = getattr(args, "_config_sci_hub", None)
    if "sci-hub" in download_providers and (sci_hub is None or not sci_hub.enabled):
        parser.error("sci-hub requires an explicitly enabled [acquisition.sci_hub] config")


def _serialize(output: MetadataSearchOutput) -> str:
    results = []
    for result in output.results:
        metadata = result.metadata
        results.append({
            "identifiers": [
                {"namespace": identifier.namespace, "value": identifier.value}
                for identifier in result.identifiers
                if identifier.namespace in PUBLIC_IDENTIFIER_NAMESPACES
            ],
            "metadata": {
                "abstract": metadata.abstract,
                "authors": list(metadata.authors),
                "open_access_status": result.work_version.open_access_status,
                "publication_date": result.work_version.publication_date,
                "title": metadata.title,
                "venue": metadata.venue,
                "year": metadata.year,
            },
            "providers": list(result.providers),
            "work_id": result.work_version.work_id,
            "work_version_id": result.work_version.id,
        })
    failures = [
        {"category": item.category, "message": item.message, "provider": item.provider}
        for item in output.failures
    ]
    return canonical_json({
        "counts": {"failures": len(failures), "results": len(results)},
        "failures": failures,
        "results": results,
    })


_STOPS = {
    "metadata": CompletionStop.METADATA,
    "download": CompletionStop.ASSET,
    "analyze": CompletionStop.COMPLETE,
}


def run(args: argparse.Namespace) -> int:
    """Run metadata search with stable, sanitized operational failures."""
    runtime = None
    try:
        credentials = getattr(args, "_config_credentials", None) or CredentialsConfig()
        metadata = MetadataCliConfig(
            args.query, tuple(args.provider), tuple(args.precedence), args.limit,
            args.provider_timeout, args.max_concurrency, args.crossref_mailto, credentials,
        )
        acquisition = AcquisitionCliConfig(
            tuple(args.download_provider), args.download_provider_concurrency,
            args.host_concurrency, args.host_min_interval, args.max_asset_bytes,
            args.forbidden_urls, credentials,
            getattr(args, "_config_sci_hub", None) or SciHubConfig(),
            getattr(args, "_config_translator", None) or TranslatorConfig(),
            getattr(args, "_config_browser", None) or BrowserConfig(),
            getattr(args, "_document_start_interval_seconds", 30.0),
        )
        analysis_config = getattr(args, "_config_analysis", None)
        analysis = None if analysis_config is None else AnalysisCliRuntime(analysis_config)
        runtime = build_search_completion_runtime(SearchCliRuntime(
            args.catalog, args.level, metadata, args.storage_root, acquisition,
            args.download_timeout, analysis,
        ))
        try:
            doi = DoiTarget(args.query)
        except ValueError:
            output = runtime.search()
            targets = tuple(WorkVersionTarget(value) for value in runtime.targets(output))
            payload = json.loads(_serialize(output))
            exact = False
        else:
            targets = (doi,)
            payload = {"counts": {"failures": 0, "results": 0}, "failures": [], "results": []}
            exact = True
        batch = asyncio.run(run_completion_batch(runtime.completion.pipeline, targets, _STOPS[args.level]))
        if exact:
            failures = runtime.exact_failures()
            payload["failures"] = failures
            payload["counts"]["failures"] = len(failures)
        payload["completion"] = batch.to_dict(_STOPS[args.level])
        optional = []
        if args.xml or args.html:
            for item in batch.items:
                if item.status is not BatchItemStatus.SUCCEEDED or item.work_version_id is None:
                    continue
                target = WorkVersionTarget(item.work_version_id)
                for kind, enabled in ((OptionalAssetKind.XML, args.xml), (OptionalAssetKind.HTML, args.html)):
                    if enabled:
                        optional.append(asyncio.run(runtime.completion.pipeline.acquire_optional(
                            OptionalAssetRequest(target, kind))).to_dict())
        payload["optional_assets"] = optional
        print(canonical_json(payload))
        if batch.interrupted:
            return 130
        if (exact and batch.succeeded == 0
                and any(item.status is BatchItemStatus.EXHAUSTED for item in batch.items)):
            return 1
        return 0
    except KeyboardInterrupt:
        print(canonical_json({"completion": {"items": [], "succeeded": 0, "failed": 0,
              "duplicates": 0, "interrupted": True}, "optional_assets": []}))
        return 130
    except (SearchError, SciRetrieverError, OSError, TypeError, ValueError) as error:
        if isinstance(error, SearchError) and str(error).startswith("all metadata search providers failed:"):
            detail = "all metadata search providers failed"
        else:
            detail = "metadata search failed"
        print(f"sciretriever: error: {detail}", file=sys.stderr)
        return 1
    except Exception:
        print("sciretriever: error: metadata search failed", file=sys.stderr)
        return 1
    finally:
        if runtime is not None:
            runtime.close()


__all__ = ("ALL_PROVIDERS", "DEFAULT_PROVIDERS", "configure_parser", "run", "validate_arguments")
