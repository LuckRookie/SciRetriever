"""Analyze selected WorkVersions through shared completion."""

from __future__ import annotations

import argparse
import anyio
from pathlib import Path
import sys
from sciretriever.catalog import LibraryFilters, WorkVersionAnalysisRepository, canonical_json
from sciretriever.config import AnalysisConfig
from sciretriever.errors import SciRetrieverError
from sciretriever.cli.analysis_runtime import AnalysisCliRuntime
from sciretriever.cli.completion_context import CommandCompletionRuntime
from sciretriever.cli.completion_runtime import build_command_completion_runtime
from sciretriever.completion import (
    BatchResult, CompletionStop, ForceAnalysisBatchResult, WorkVersionTarget,
    run_completion_batch, run_force_analysis_batch,
)


def configure_parser(parser: argparse.ArgumentParser) -> None:
    parser.description = "Analyze accepted primary PDFs for existing WorkVersions."
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--storage-root", required=True, type=Path)
    exact = parser.add_mutually_exclusive_group()
    exact.add_argument("--work-version-id")
    exact.add_argument("--work-id")
    exact.add_argument("--all-pending", action="store_true")
    exact.add_argument("--all-current", action="store_true")
    parser.add_argument("--query")
    parser.add_argument("--author")
    parser.add_argument("--year", type=int)
    parser.add_argument("--publisher")
    parser.add_argument("--venue")
    parser.add_argument("--tag")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--force", action="store_true")


def validate_arguments(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    filters = (args.query, args.author, args.year, args.publisher, args.venue, args.tag)
    exact = args.work_version_id is not None or args.work_id is not None or args.all_pending or args.all_current
    if exact and any(value is not None for value in filters):
        parser.error("exact and all selectors cannot be combined with query or filters")
    if not exact and not any(value is not None for value in filters):
        parser.error("analyze requires an exact ID, query/filter, --all-pending, or --all-current --force")
    if args.all_current and not args.force:
        parser.error("--all-current requires --force")
    if args.limit <= 0:
        parser.error("--limit must be positive")
    config: AnalysisConfig | None = getattr(args, "_config_analysis", None)
    if (config is None or config.mineru.mode == "disabled" or config.mineru.endpoint is None
            or config.mineru.model is None or config.llm.endpoint is None or config.llm.model is None
            or config.llm.credential_env is None):
        parser.error("analyze requires fully enabled [analysis.mineru] and [analysis.llm] config")


def _selection(repository: WorkVersionAnalysisRepository, args: argparse.Namespace) -> tuple[str, ...]:
    if args.work_version_id is not None or args.work_id is not None:
        return repository.select_exact(work_version_id=args.work_version_id, work_id=args.work_id,
                                       force=args.force).work_version_ids
    if args.all_pending:
        return repository.select_all_pending(limit=args.limit).work_version_ids
    if args.all_current:
        return repository.select_all_current(limit=args.limit, force=args.force).work_version_ids
    return repository.select_library(args.query, filters=LibraryFilters(author=args.author,
        publication_year=args.year, publisher=args.publisher, venue=args.venue, tag=args.tag),
        limit=args.limit, force=args.force).work_version_ids


def build_analysis_completion_runtime(args: argparse.Namespace) -> CommandCompletionRuntime:
    config: AnalysisConfig = args._config_analysis
    defaults = AnalysisCliRuntime(config)
    analysis = AnalysisCliRuntime(
        config,
        getattr(args, "_credential_reader", None) or defaults.credential_reader,
        getattr(args, "_mineru_client_factory", None) or defaults.mineru_client_factory,
        getattr(args, "_analysis_provider_factory", None) or defaults.analysis_provider_factory,
    )
    return build_command_completion_runtime(
        args.catalog, args.storage_root, analysis=analysis
    )


def _selected_targets(
    repository: WorkVersionAnalysisRepository, args: argparse.Namespace,
) -> tuple[WorkVersionTarget, ...]:
    return tuple(WorkVersionTarget(value) for value in _selection(repository, args))


def _execute(args: argparse.Namespace) -> BatchResult | ForceAnalysisBatchResult:
    runtime = build_analysis_completion_runtime(args)
    try:
        targets = _selected_targets(WorkVersionAnalysisRepository(runtime.catalog), args)
        if args.force:
            return run_force_analysis_batch(runtime.completion.pipeline, targets)
        return anyio.run(
            run_completion_batch, runtime.completion.pipeline, targets,
            CompletionStop.COMPLETE,
        )
    finally:
        runtime.close()


def run(args: argparse.Namespace) -> int:
    try:
        result = _execute(args)
    except KeyboardInterrupt:
        print(canonical_json({"items": [], "failed": 0, "interrupted": True}))
        return 130
    except (OSError, SciRetrieverError, TypeError, ValueError):
        print("sciretriever: error: analyze failed", file=sys.stderr)
        return 1
    payload = result.to_dict() if isinstance(result, ForceAnalysisBatchResult) else result.to_dict(CompletionStop.COMPLETE)
    print(canonical_json(payload))
    return 130 if result.interrupted else 0


__all__ = ("configure_parser", "run", "validate_arguments")
