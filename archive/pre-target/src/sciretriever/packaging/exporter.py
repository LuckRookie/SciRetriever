"""Verified byte-preserving export of immutable package snapshots."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.records import PackageVersionRecord
from sciretriever.core.export import PackageExportRequest
from sciretriever.core.export_errors import ExportContractError
from sciretriever.core.export_publication import ExportPublication, publish_export
from sciretriever.errors import PackagingError, StorageError
from sciretriever.storage import DerivedArtifactStore

from .publisher import PackagePublisher


@dataclass(frozen=True, slots=True)
class PackageExportResult:
    package_version: int
    package_sha256: str
    package_bytes: bytes


class PackageExporter:
    def __init__(self, catalog: CatalogEngine, derived_store: DerivedArtifactStore) -> None:
        self.publisher = PackagePublisher(catalog, derived_store)
        self.derived_store = derived_store
        self.catalog_path = catalog.path

    def _select(self, request: PackageExportRequest) -> PackageVersionRecord:
        selector = request.selector
        if selector.package_version is None:
            record = self.publisher.versions.latest(selector.work_version_id)
        else:
            if selector.package_sha256 is None:
                raise PackagingError("exact package selection requires a hash")
            record = self.publisher.versions.get_by_version(
                selector.work_version_id, selector.package_version
            )
            if record is not None and record.sha256 != selector.package_sha256:
                record = None
        if record is None:
            raise PackagingError("selected document package does not exist")
        return record

    def export(self, request: PackageExportRequest) -> PackageExportResult:
        if not isinstance(request, PackageExportRequest):
            raise PackagingError("request must be a PackageExportRequest")
        record = self._select(request)
        try:
            package = self.publisher.load_verified(record)
            owner_id = record.storage_path.rsplit("/", 1)[-1]
            publication = self.derived_store.find_published("document_package", owner_id)
            if publication is None:
                raise PackagingError("package storage is missing")
            stored_bytes = self.derived_store.read_verified(publication)
        except (StorageError, UnicodeDecodeError, TypeError, ValueError) as error:
            raise PackagingError("package storage failed integrity validation") from error
        package_bytes = package.to_json().encode("utf-8")
        if stored_bytes != package_bytes:
            raise PackagingError("package storage is not canonical")
        try:
            publish_export(ExportPublication(
                request.destination.path,
                self.catalog_path,
                package_bytes,
            ))
        except (ExportContractError, StorageError) as error:
            raise PackagingError("package export could not be published safely") from error
        return PackageExportResult(record.version, record.sha256, package_bytes)


__all__ = ("PackageExporter", "PackageExportResult")
