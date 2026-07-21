"""Catalog creation and explicit one-shot import commands."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

from sciretriever.acquisition.admission import AdmissionService
from sciretriever.catalog.assets import AssetRepository
from sciretriever.catalog.engine import create_catalog_engine, open_catalog_engine
from sciretriever.catalog.identity import IdentityResolver
from sciretriever.catalog.jobs import JobRepository
from sciretriever.catalog.migrate import MIGRATION_MODULES, applied_migrations, apply_migrations
from sciretriever.catalog.repository import CatalogRepository
from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole
from sciretriever.legacy import ExistingAssetImporter, LegacyPaperAdapter, LegacySQLiteReader
from sciretriever.errors import SciRetrieverError
from sciretriever.storage.coordinator import AssetAcceptanceCoordinator
from sciretriever.storage.manager import RawAssetStore


def configure_parser(parser: argparse.ArgumentParser) -> None:
    commands = parser.add_subparsers(dest="catalog_command", required=True, metavar="COMMAND")
    create = commands.add_parser("create", help="create and migrate a new v2 catalog")
    create.add_argument("--catalog", required=True)

    asset = commands.add_parser("import-asset", help="import one existing PDF, XML, or HTML asset")
    _add_import_paths(asset)
    asset.add_argument("--asset", required=True)
    asset.add_argument("--asset-role", required=True, choices=tuple(role.value for role in AssetRole))
    asset.add_argument("--identifier", required=True, action="append", type=_identifier)

    legacy = commands.add_parser("import-legacy-db", help="one-shot import of a legacy papers database")
    _add_import_paths(legacy)
    legacy.add_argument("--legacy-db", required=True)
    legacy.add_argument("--asset-root", required=True)
    legacy.add_argument("--legacy-source-id", required=True)


def _add_import_paths(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--storage-root", required=True)


def _identifier(value: str) -> Identifier:
    namespace, separator, identifier_value = value.partition("=")
    if not separator or not namespace.strip() or not identifier_value.strip():
        raise argparse.ArgumentTypeError("identifier must use NAMESPACE=VALUE")
    try:
        return Identifier(namespace, identifier_value)
    except (TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def _importer(catalog_path: str, storage_root: str):
    catalog = open_catalog_engine(catalog_path)
    try:
        expected = tuple(name.rsplit(".", 1)[-1][:4] for name in MIGRATION_MODULES)
        if applied_migrations(catalog) != expected:
            raise ValueError("catalog is not fully migrated")
        root = Path(storage_root).expanduser()
        if not root.is_dir() or root.is_symlink():
            raise ValueError("storage root must be an existing real directory")
        assets = AssetRepository(catalog)
        jobs = JobRepository(catalog)
        repository = CatalogRepository(catalog)
        importer = ExistingAssetImporter(
            AdmissionService(IdentityResolver(catalog), jobs, assets),
            repository,
            jobs,
            assets,
            AssetAcceptanceCoordinator(assets, RawAssetStore(root)),
        )
        return catalog, importer
    except BaseException:
        catalog.dispose()
        raise


def _create(args: argparse.Namespace) -> int:
    catalog = create_catalog_engine(args.catalog)
    try:
        revisions = apply_migrations(catalog)
        print(f"disposition=created catalog={catalog.path} migrations={','.join(revisions)}")
        return 0
    finally:
        catalog.dispose()


def _import_asset(args: argparse.Namespace) -> int:
    identifiers = tuple(args.identifier)
    catalog, importer = _importer(args.catalog, args.storage_root)
    try:
        result = importer.import_asset(args.asset, identifiers, AssetRole(args.asset_role))
        print(
            f"disposition={result.disposition} work_id={result.work_id} "
            f"raw_asset_id={result.raw_asset_id} sha256={result.sha256}"
        )
        return 0
    finally:
        catalog.dispose()


def _import_legacy(args: argparse.Namespace) -> int:
    asset_root = Path(args.asset_root).expanduser()
    if not asset_root.is_dir() or asset_root.is_symlink():
        raise ValueError("asset root must be an existing real directory")
    reader = LegacySQLiteReader(args.legacy_db)
    catalog, importer = _importer(args.catalog, args.storage_root)
    imported = replayed = skipped = failed = 0
    try:
        for row in reader.rows():
            try:
                record = LegacyPaperAdapter.map(row, args.legacy_source_id)
                if record.pdf_path is None:
                    skipped += 1
                    continue
                result = importer.import_asset(
                    record.pdf_path,
                    record.identifiers,
                    AssetRole.PRIMARY_PDF,
                    record.metadata,
                    asset_root=asset_root,
                    source_id=record.source_id,
                )
                if result.disposition == "imported":
                    imported += 1
                else:
                    replayed += 1
            except (OSError, SciRetrieverError, RuntimeError, TypeError, ValueError) as error:
                failed += 1
                print(f"row_id={row.get('id', '')} disposition=failed error={type(error).__name__}", file=sys.stderr)
        print(f"imported={imported} replayed={replayed} skipped={skipped} failed={failed}")
        return 1 if failed else 0
    finally:
        catalog.dispose()


def run(args: argparse.Namespace) -> int:
    try:
        if args.catalog_command == "create":
            return _create(args)
        if args.catalog_command == "import-asset":
            return _import_asset(args)
        if args.catalog_command == "import-legacy-db":
            return _import_legacy(args)
        raise ValueError("unknown catalog command")
    except (OSError, SciRetrieverError, RuntimeError, TypeError, ValueError) as error:
        print(f"sciretriever: error: {error}", file=sys.stderr)
        return 1


__all__ = ("configure_parser", "run")
