"""Offline DocumentPackageVersion pipeline command."""

from __future__ import annotations

import argparse
import sys

from sciretriever.catalog import open_catalog_engine
from sciretriever.normalization.contracts import NormalizationParameters
from sciretriever.packaging.pipeline import PackagePipeline
from sciretriever.storage import DerivedArtifactStore, RawAssetStore


_NORMALIZATION_DEFAULTS = NormalizationParameters()


def _positive(value: str) -> int:
    try:
        result = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive integer") from error
    if result <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return result


def configure_parser(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--catalog", required=True, help="existing writable catalog path")
    parser.add_argument("--storage-root", required=True, help="existing immutable storage root")
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--work-id")
    selection.add_argument("--raw-asset-id")
    parser.add_argument(
        "--work-version-id",
        help="disambiguate a raw asset linked to multiple WorkVersions",
    )
    parser.add_argument("--max-input-bytes", type=_positive, default=_NORMALIZATION_DEFAULTS.max_input_bytes)
    parser.add_argument("--max-pages", type=_positive, default=_NORMALIZATION_DEFAULTS.max_pages)
    parser.add_argument("--max-structural-units", type=_positive, default=_NORMALIZATION_DEFAULTS.max_structural_units)
    parser.add_argument("--max-depth", type=_positive, default=_NORMALIZATION_DEFAULTS.max_depth)
    parser.add_argument("--max-elements", type=_positive, default=_NORMALIZATION_DEFAULTS.max_elements)
    parser.add_argument("--max-text-characters", type=_positive, default=_NORMALIZATION_DEFAULTS.max_text_characters)


def run(args: argparse.Namespace) -> int:
    catalog = None
    try:
        catalog = open_catalog_engine(args.catalog)
        raw = RawAssetStore(args.storage_root)
        derived = DerivedArtifactStore(args.storage_root)
        parameters = NormalizationParameters(
            max_input_bytes=args.max_input_bytes,
            max_pages=args.max_pages,
            max_structural_units=args.max_structural_units,
            max_depth=args.max_depth,
            max_elements=args.max_elements,
            max_text_characters=args.max_text_characters,
        )
        result = PackagePipeline(
            catalog, raw, derived,
            normalization_parameters=parameters,
        ).run(
            work_id=args.work_id,
            raw_asset_id=args.raw_asset_id,
            work_version_id=getattr(args, "work_version_id", None),
        )
        disposition = "created" if result.created else "replayed"
        print(
            f"disposition={disposition} version={result.package.package_version} "
            f"quality={result.package.quality.value} "
            f"sha256={result.package.package_sha256} path={result.record.storage_path}"
        )
        return 0
    except Exception as error:
        print(f"sciretriever: error: {error}", file=sys.stderr)
        return 1
    finally:
        if catalog is not None:
            catalog.dispose()


__all__ = ("configure_parser", "run")
