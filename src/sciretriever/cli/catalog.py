"""Catalog creation and explicit existing-asset import commands."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

from sciretriever.acquisition.admission import AdmissionService
from sciretriever.catalog.assets import AssetRepository
from sciretriever.catalog.engine import create_catalog_engine, open_catalog_engine
from sciretriever.catalog.identity import IdentityResolver
from sciretriever.catalog.jobs import JobRepository
from sciretriever.catalog.repository import CatalogRepository
from sciretriever.catalog.schema import initialize_catalog
from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole
from sciretriever.acquisition.existing_asset import ExistingAssetImporter
from sciretriever.errors import SciRetrieverError
from sciretriever.storage.coordinator import AssetAcceptanceCoordinator
from sciretriever.storage.manager import RawAssetStore


def configure_parser(parser: argparse.ArgumentParser) -> None:
    commands = parser.add_subparsers(dest="catalog_command", required=True, metavar="COMMAND")
    create = commands.add_parser("create", help="create a fresh catalog")
    create.add_argument("--catalog", required=True)

    asset = commands.add_parser("import-asset", help="import one existing PDF, XML, or HTML asset")
    _add_import_paths(asset)
    asset.add_argument("--asset", required=True)
    asset.add_argument("--asset-role", required=True, choices=tuple(role.value for role in AssetRole))
    asset.add_argument("--identifier", required=True, action="append", type=_identifier)

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
        initialize_catalog(catalog)
        print(f"disposition=created catalog={catalog.path}")
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
