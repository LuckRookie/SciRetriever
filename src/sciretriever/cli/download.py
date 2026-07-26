"""Download selected WorkVersions through shared completion."""

from __future__ import annotations

import argparse
import anyio
from pathlib import Path
import sys

from sciretriever.acquisition.policy_files import read_policy_lines
from sciretriever.acquisition.transport import MAX_RESPONSE_BYTES
from sciretriever.catalog import (
    LibraryFilters,
    WorkVersionDownloadRepository,
    canonical_json,
)
from sciretriever.config import (
    ACQUISITION_PROVIDERS, BrowserConfig, CredentialsConfig, SciHubConfig, TranslatorConfig,
)
from sciretriever.errors import SciRetrieverError
from sciretriever.cli.acquisition_runtime import AcquisitionCliConfig, build_acquisition_service
from sciretriever.cli.completion_context import CommandCompletionRuntime
from sciretriever.cli.completion_runtime import build_command_completion_runtime
from sciretriever.completion import (
    BatchItemStatus, BatchResult, CompletionStop, OptionalAssetKind,
    OptionalAssetRequest, WorkVersionTarget, run_completion_batch,
)
from sciretriever.completion.batch import JsonObject


DEFAULT_PROVIDERS = (
    "direct", "arxiv", "crossref", "unpaywall", "europe-pmc", "openalex",
    "semantic-scholar", "elsevier", "wiley", "springer",
)
def configure_parser(parser: argparse.ArgumentParser) -> None:
    parser.description = "Download missing assets for existing WorkVersions."
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--storage-root", required=True, type=Path)
    exact = parser.add_mutually_exclusive_group()
    exact.add_argument("--work-version-id")
    exact.add_argument("--work-id")
    exact.add_argument("--all-missing", action="store_true")
    parser.add_argument("--query")
    parser.add_argument("--author")
    parser.add_argument("--year", type=int)
    parser.add_argument("--publisher")
    parser.add_argument("--venue")
    parser.add_argument("--tag")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--provider", action="append", choices=tuple(sorted(ACQUISITION_PROVIDERS)))
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--provider-concurrency", type=int, default=4)
    parser.add_argument("--host-concurrency", type=int, default=2)
    parser.add_argument("--host-min-interval", type=float, default=0.0)
    parser.add_argument("--max-asset-bytes", type=int, default=MAX_RESPONSE_BYTES)
    parser.add_argument("--forbidden-urls", type=Path)
    parser.add_argument("--xml", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--html", action=argparse.BooleanOptionalAction, default=False)


def validate_arguments(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    filters = (args.query, args.author, args.year, args.publisher, args.venue, args.tag)
    exact = args.work_version_id is not None or args.work_id is not None or args.all_missing
    if exact and any(value is not None for value in filters):
        parser.error("exact and --all-missing selectors cannot be combined with query or filters")
    if not exact and not any(value is not None for value in filters):
        parser.error("download requires an exact ID, query/filter, or --all-missing")
    for name in ("limit", "provider_concurrency", "host_concurrency", "max_asset_bytes"):
        if getattr(args, name) <= 0:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    if args.host_min_interval < 0:
        parser.error("--host-min-interval must be nonnegative")
    providers = args.provider or list(DEFAULT_PROVIDERS)
    if len(providers) != len(set(providers)):
        parser.error("--provider must not contain duplicates")
    args.provider = providers
    sci_hub: SciHubConfig | None = getattr(args, "_config_sci_hub", None)
    if "sci-hub" in providers and (sci_hub is None or not sci_hub.enabled):
        parser.error("sci-hub requires an explicitly enabled [acquisition.sci_hub] config")


def _forbidden(path: Path | None) -> tuple[str, ...]:
    if path is None:
        return ()
    return read_policy_lines(path)


def _selection(repository: WorkVersionDownloadRepository, args: argparse.Namespace) -> tuple[str, ...]:
    if args.work_version_id is not None or args.work_id is not None:
        return repository.select_exact(
            work_version_id=args.work_version_id, work_id=args.work_id
        ).work_version_ids
    if args.all_missing:
        return repository.select_all_missing_primary_pdf().work_version_ids
    filters = LibraryFilters(
        author=args.author,
        publication_year=args.year,
        publisher=args.publisher,
        venue=args.venue,
        tag=args.tag,
    )
    return repository.select_library(args.query, filters=filters, limit=args.limit).work_version_ids


def build_download_completion_runtime(args: argparse.Namespace) -> CommandCompletionRuntime:
    acquisition = AcquisitionCliConfig(
        tuple(args.provider), args.provider_concurrency, args.host_concurrency,
        args.host_min_interval, args.max_asset_bytes, args.forbidden_urls,
        getattr(args, "_config_credentials", None) or CredentialsConfig(),
        getattr(args, "_config_sci_hub", None) or SciHubConfig(),
        getattr(args, "_config_translator", None) or TranslatorConfig(),
        getattr(args, "_config_browser", None) or BrowserConfig(),
        getattr(args, "_document_start_interval_seconds", 30.0),
    )
    return build_command_completion_runtime(
        args.catalog, args.storage_root, acquisition=acquisition,
        acquisition_timeout=args.timeout,
    )


def _acquire_optional(
    runtime: CommandCompletionRuntime, args: argparse.Namespace, batch: BatchResult,
) -> list[JsonObject]:
    results: list[JsonObject] = []
    for item in batch.items:
        if item.status is not BatchItemStatus.SUCCEEDED or item.work_version_id is None:
            continue
        target = WorkVersionTarget(item.work_version_id)
        for kind, enabled in ((OptionalAssetKind.XML, args.xml),
                              (OptionalAssetKind.HTML, args.html)):
            if enabled:
                result = anyio.run(
                    runtime.completion.pipeline.acquire_optional,
                    OptionalAssetRequest(target, kind),
                )
                results.append(result.to_dict())
    return results


def _execute(args: argparse.Namespace) -> tuple[BatchResult, list[JsonObject]]:
    runtime = build_download_completion_runtime(args)
    try:
        selected = _selection(WorkVersionDownloadRepository(runtime.catalog), args)
        targets = tuple(WorkVersionTarget(value) for value in selected)
        result = anyio.run(
            run_completion_batch, runtime.completion.pipeline, targets, CompletionStop.ASSET
        )
        return result, _acquire_optional(runtime, args, result)
    finally:
        runtime.close()


def run(args: argparse.Namespace) -> int:
    try:
        result, optional = _execute(args)
    except KeyboardInterrupt:
        print(canonical_json({"items": [], "succeeded": 0, "failed": 0,
                              "duplicates": 0, "interrupted": True,
                              "optional_assets": []}))
        return 130
    except (OSError, SciRetrieverError, TypeError, ValueError):
        print("sciretriever: error: download failed", file=sys.stderr)
        return 1
    print(canonical_json({**result.to_dict(CompletionStop.ASSET), "optional_assets": optional}))
    return 130 if result.interrupted else 0


__all__ = (
    "configure_parser", "run", "validate_arguments",
)
