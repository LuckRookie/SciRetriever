"""CLI composition for typed reading and package exports."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import sys
from typing import assert_never

from sqlalchemy.exc import SQLAlchemyError

from sciretriever.catalog import LibraryReadRepository, open_catalog_engine, open_read_only_catalog_engine
from sciretriever.core.export import (
    ExportDestination,
    ExportFormat,
    ExportMode,
    PackageExportDisposition,
    PackageExportRequest,
    PackageExportSelector,
    ReadingExportReferences,
    ReadingExportRequest,
    ReadingExportSelector,
)
from sciretriever.errors import CatalogError, PackagingError, StorageError
from sciretriever.packaging import PackageExporter, PackagePipeline
from sciretriever.storage import DerivedArtifactStore, RawAssetStore


@dataclass(frozen=True, slots=True)
class PackageCliResult:
    disposition: PackageExportDisposition
    package_version: int
    package_sha256: str
    work_version_id: str

    def to_json(self) -> str:
        return json.dumps({
            "disposition": self.disposition.value,
            "mode": ExportMode.PACKAGE.value,
            "package_sha256": self.package_sha256,
            "package_version": self.package_version,
            "work_version_id": self.work_version_id,
        }, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def validate_arguments(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    mode = ExportMode(args.mode)
    match mode:
        case ExportMode.READING:
            if (args.work_id is None) == (args.work_version_id is None):
                parser.error("reading export requires exactly one --work-id or --work-version-id")
            if any(value is not None for value in (
                args.storage_root, args.package_version, args.package_sha256,
            )):
                parser.error("reading export does not accept package options")
        case ExportMode.PACKAGE:
            if args.work_id is not None or args.work_version_id is None:
                parser.error("package export requires exactly one --work-version-id")
            if args.storage_root is None:
                parser.error("package export requires --storage-root")
            if args.include_references or args.include_light_content or args.limit is not None:
                parser.error("package export does not accept reading options")
            if args.format not in (None, ExportFormat.JSON.value):
                parser.error("package export format must be json")
            if (args.package_version is None) != (args.package_sha256 is None):
                parser.error("--package-version and --package-sha256 must be supplied together")
        case unreachable:
            assert_never(unreachable)


def _reading_request(args: argparse.Namespace) -> ReadingExportRequest:
    return ReadingExportRequest(
        ReadingExportSelector(args.work_id, args.work_version_id),
        ReadingExportReferences.INCLUDE if args.include_references else ReadingExportReferences.OMIT,
        ExportFormat(args.format or ExportFormat.JSON.value),
        ExportDestination.parse(args.output, args.catalog),
    )


def _run_reading(args: argparse.Namespace) -> int:
    request = _reading_request(args)
    engine = open_read_only_catalog_engine(args.catalog)
    try:
        result = LibraryReadRepository(engine).exact_lookup(
            work_id=request.selector.work_id,
            work_version_id=request.selector.work_version_id,
            include_light_content=args.include_light_content,
            include_references=request.references is ReadingExportReferences.INCLUDE,
            limit=args.limit or 100,
        )
        from sciretriever.cli.library import _atomic_write, _render

        _atomic_write(request.destination.path, _render(result, request.output_format.value), engine.path)
    finally:
        engine.dispose()
    print(f"Exported {len(result.items)} entries to {request.destination.path.expanduser()}")
    return 0


def _run_package(args: argparse.Namespace) -> int:
    selector = PackageExportSelector(
        args.work_version_id, args.package_version, args.package_sha256,
    )
    destination = ExportDestination.parse(args.output, args.catalog)
    catalog = open_catalog_engine(args.catalog, allow_repository_write=True)
    try:
        raw_store = RawAssetStore(args.storage_root)
        derived_store = DerivedArtifactStore(args.storage_root)
        disposition = PackageExportDisposition.REPLAYED
        if selector.package_version is None:
            publication = PackagePipeline(catalog, raw_store, derived_store).run(
                work_version_id=selector.work_version_id,
            )
            disposition = (
                PackageExportDisposition.NEW_VERSION
                if publication.created
                else PackageExportDisposition.REPLAYED
            )
            selector = PackageExportSelector(
                selector.work_version_id, publication.record.version, publication.record.sha256,
            )
        request = PackageExportRequest(
            selector,
            destination,
        )
        exported = PackageExporter(catalog, derived_store).export(request)
    finally:
        catalog.dispose()
    print(PackageCliResult(
        disposition, exported.package_version, exported.package_sha256, selector.work_version_id,
    ).to_json())
    return 0


def run(args: argparse.Namespace) -> int:
    try:
        match ExportMode(args.mode):
            case ExportMode.READING:
                return _run_reading(args)
            case ExportMode.PACKAGE:
                return _run_package(args)
            case unreachable:
                assert_never(unreachable)
    except (CatalogError, PackagingError, StorageError, SQLAlchemyError, OSError, TypeError, ValueError):
        print("sciretriever: error: library operation failed", file=sys.stderr)
        return 1


__all__ = ("run", "validate_arguments")
