"""Foreground current-analysis backfill command."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys
from typing import Any, cast

from sciretriever.analysis import AnalysisBackfillResult, AnalysisBackfillService, AnalysisService, OpenAICompatibleAnalysisProvider
from sciretriever.catalog import AssetRepository, LibraryFilters, WorkVersionAnalysisRepository, canonical_json, open_catalog_engine
from sciretriever.config import AnalysisConfig, get_credential
from sciretriever.errors import SciRetrieverError
from sciretriever.normalization import MinerUClient, MinerUParsingService, MinerUSourceMapService
from sciretriever.storage import DerivedArtifactStore, RawAssetStore


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


def execute_work_versions(args: argparse.Namespace, selected: tuple[str, ...]) -> AnalysisBackfillResult:
    root = args.storage_root.expanduser()
    if not root.is_dir() or root.is_symlink():
        raise ValueError("storage root must be an existing real directory")
    config: AnalysisConfig = args._config_analysis
    endpoint, model = config.llm.endpoint, config.llm.model
    if endpoint is None or model is None:
        raise ValueError("analysis LLM target is incomplete")
    credential_reader = getattr(args, "_credential_reader", get_credential)
    credential = credential_reader(config.llm.credential_env or "")
    if credential is None:
        raise ValueError("analysis LLM credential is unavailable")
    engine = open_catalog_engine(args.catalog)
    try:
        raw_store, derived_store = RawAssetStore(root), DerivedArtifactStore(root)
        client_factory = getattr(args, "_mineru_client_factory", MinerUClient)
        provider_factory = getattr(args, "_analysis_provider_factory", OpenAICompatibleAnalysisProvider)
        client = client_factory(config.mineru)
        provider = provider_factory(api_key=credential, base_url=endpoint,
                                    model=model, timeout=config.llm.timeout)
        assets = AssetRepository(engine)
        parsing = MinerUParsingService(engine, derived_store, config.mineru, cast(Any, client))
        mapping = MinerUSourceMapService(engine, raw_store, derived_store)
        analysis = AnalysisService(engine, derived_store, provider,
            max_input_characters=config.llm.max_input_characters,
            max_source_units=config.llm.max_source_units,
            max_completion_tokens=config.llm.max_output_tokens,
            configuration={"endpoint": endpoint, "model": model,
                           "timeout": config.llm.timeout})
        repository = WorkVersionAnalysisRepository(engine)
        def analyze_one(record, force: bool) -> str:
            raw = assets.get_raw_asset(record.primary_pdf_id or "")
            if raw is None:
                raise ValueError("primary PDF record is missing")
            pdf = raw_store.read_verified(raw.storage_path, raw.sha256, raw.byte_size, config.mineru.max_upload_bytes)
            before = record.current_id
            parsed = parsing.run(record.work_version_id, raw.id, pdf)
            source = mapping.run(record.work_version_id, parsed)
            analysis.run(record.work_version_id, source, expected_current_id=record.current_id,
                         expected_revision=record.current_revision, force=force)
            return "reused" if before is not None and not force else "analyzed"
        service = AnalysisBackfillService(repository, analyze_one)
        args._analysis_backfill_service = service
        return service.run(selected, force=args.force)
    finally:
        engine.dispose()


def interrupted_result(args: argparse.Namespace) -> AnalysisBackfillResult:
    service = getattr(args, "_analysis_backfill_service", None)
    if service is None:
        return AnalysisBackfillResult(0, 0, 0, 0, 0, 0, ())
    result = service.last_result
    return AnalysisBackfillResult(result.selected, result.analyzed, result.reused, result.blocked,
        result.failed, max(result.interrupted, result.selected - len(result.outcomes)), result.outcomes)


def run(args: argparse.Namespace) -> int:
    try:
        engine = open_catalog_engine(args.catalog)
        try:
            selected = _selection(WorkVersionAnalysisRepository(engine), args)
        finally:
            engine.dispose()
        result = execute_work_versions(args, selected)
    except KeyboardInterrupt:
        print(canonical_json(interrupted_result(args).to_dict()))
        return 130
    except (OSError, SciRetrieverError, TypeError, ValueError):
        print("sciretriever: error: analyze failed", file=sys.stderr)
        return 1
    print(canonical_json(result.to_dict()))
    return 130 if result.interrupted else 0


__all__ = ("configure_parser", "execute_work_versions", "interrupted_result", "run", "validate_arguments")
