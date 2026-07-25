"""Catalog creation and explicit existing-asset import commands."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys
import anyio

from sciretriever.catalog.completion_facts import CompletionFactsRepository, CompletionStage
from sciretriever.catalog.engine import create_catalog_engine, open_catalog_engine
from sciretriever.catalog.schema import initialize_catalog
from sciretriever.core.enums import AssetRole
from sciretriever.errors import ConfigError, SciRetrieverError
from sciretriever.cli.analysis_runtime import AnalysisCliRuntime
from sciretriever.cli.completion_runtime import (
    CompletionRuntime, build_completion_runtime,
    build_existing_asset_importer,
)
from sciretriever.cli.completion_context import (
    CompletionInvocationContext, CompletionRuntimeOptions,
)
from sciretriever.completion import CompletionStop, WorkVersionTarget
from sciretriever.config import AnalysisConfig


def configure_parser(parser: argparse.ArgumentParser) -> None:
    commands = parser.add_subparsers(dest="catalog_command", required=True, metavar="COMMAND")
    create = commands.add_parser("create", help="create a fresh catalog")
    create.add_argument("--catalog", required=True)

    asset = commands.add_parser("import-asset", help="import one existing PDF, XML, or HTML asset")
    _add_import_paths(asset)
    asset.add_argument("--asset", required=True)
    asset.add_argument("--asset-role", required=True, choices=tuple(role.value for role in AssetRole))
    asset.add_argument("--work-version-id", required=True)
    asset.add_argument("--stop", choices=("asset", "complete"))

def _add_import_paths(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--storage-root", required=True)


def _importer(catalog_path: str, storage_root: str):
    catalog = open_catalog_engine(catalog_path)
    try:
        root = Path(storage_root).expanduser()
        if not root.is_dir() or root.is_symlink():
            raise ValueError("storage root must be an existing real directory")
        importer = build_existing_asset_importer(catalog, root)
        return catalog, importer
    except BaseException:
        catalog.dispose()
        raise


def _create(args: argparse.Namespace) -> int:
    catalog = create_catalog_engine(args.catalog)
    try:
        initialize_catalog(catalog)
        print(f"disposition=created catalog={catalog.path}")
        return 0
    finally:
        catalog.dispose()


def build_import_completion_runtime(
    context: CompletionInvocationContext, config: AnalysisConfig | None,
    stop: CompletionStop,
) -> CompletionRuntime:
    analysis = None
    if stop is CompletionStop.COMPLETE:
        if config is None:
            raise ConfigError("complete import requires analysis configuration")
        analysis = AnalysisCliRuntime(config)
    return build_completion_runtime(context, CompletionRuntimeOptions(analysis=analysis))


def _import_asset(args: argparse.Namespace) -> int:
    catalog, importer = _importer(args.catalog, args.storage_root)
    try:
        context = CompletionInvocationContext(catalog, Path(args.storage_root))
        role = AssetRole(args.asset_role)
        result = importer.import_asset(
            args.asset, args.work_version_id, role
        )
        stage = CompletionFactsRepository(catalog).get(result.work_version_id).stage
        if role is AssetRole.PRIMARY_PDF:
            config: AnalysisConfig | None = getattr(args, "_config_analysis", None)
            configured = (
                config is not None and config.mineru.mode != "disabled"
                and config.mineru.endpoint is not None and config.mineru.model is not None
                and config.llm.endpoint is not None and config.llm.model is not None
                and config.llm.credential_env is not None
            )
            stop = CompletionStop(args.stop) if args.stop is not None else (
                CompletionStop.COMPLETE if configured else CompletionStop.ASSET
            )
            completion = build_import_completion_runtime(context, config, stop)
            anyio.run(
                completion.pipeline.ensure_complete,
                WorkVersionTarget(result.work_version_id), stop,
            )
            stage = completion.facts.get(result.work_version_id).stage
        print(
            f"disposition={result.disposition} work_version_id={result.work_version_id} "
            f"raw_asset_id={result.raw_asset_id} sha256={result.sha256} "
            f"stage={stage.name}"
        )
        return 0
    finally:
        catalog.dispose()


def run(args: argparse.Namespace) -> int:
    try:
        if args.catalog_command == "create":
            return _create(args)
        if args.catalog_command == "import-asset":
            return _import_asset(args)
        raise ValueError("unknown catalog command")
    except (OSError, SciRetrieverError, RuntimeError, TypeError, ValueError) as error:
        print(f"sciretriever: error: {error}", file=sys.stderr)
        return 1


__all__ = ("configure_parser", "run")
