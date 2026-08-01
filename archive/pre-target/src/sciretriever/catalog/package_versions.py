"""Immutable package-version registration and selection."""

from __future__ import annotations

from sqlalchemy import insert, select, update

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import package_versions, processing_runs
from sciretriever.catalog.records import PackageVersionRecord
from sciretriever.catalog.repository import _required_text, catalog_operation
from sciretriever.core.derivation import stable_derivation_id
from sciretriever.core.enums import PackageQuality, ProcessingRunState
from sciretriever.core.ids import validate_uuid
from sciretriever.core.timestamps import parse_rfc3339
from sciretriever.core.validation import validate_sha256, validate_storage_path
from sciretriever.errors import CatalogError


class PackageVersionRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine):
            raise CatalogError("catalog must be a CatalogEngine")
        if catalog.read_only:
            raise CatalogError("PackageVersionRepository requires a writable catalog")
        self._catalog = catalog

    def get(self, package_id: str) -> PackageVersionRecord | None:
        package_id = validate_uuid(package_id, "package_id")
        with self._catalog.connect() as connection:
            row = connection.execute(
                select(package_versions).where(package_versions.c.id == package_id)
            ).mappings().one_or_none()
        return None if row is None else PackageVersionRecord.from_row(row)

    def latest(self, work_version_id: str) -> PackageVersionRecord | None:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        with self._catalog.connect() as connection:
            row = connection.execute(
                select(package_versions)
                .where(package_versions.c.work_version_id == work_version_id)
                .order_by(package_versions.c.version.desc())
                .limit(1)
            ).mappings().one_or_none()
        return None if row is None else PackageVersionRecord.from_row(row)

    def get_by_version(self, work_version_id: str, version: int) -> PackageVersionRecord | None:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        if type(version) is not int or version < 1:
            raise CatalogError("version must be a positive integer")
        with self._catalog.connect() as connection:
            row = connection.execute(
                select(package_versions).where(
                    package_versions.c.work_version_id == work_version_id,
                    package_versions.c.version == version,
                )
            ).mappings().one_or_none()
        return None if row is None else PackageVersionRecord.from_row(row)

    def get_by_document_hash(
        self,
        document_id: str,
        package_sha256: str,
    ) -> PackageVersionRecord | None:
        document_id = validate_uuid(document_id, "document_id")
        package_sha256 = validate_sha256(package_sha256)
        with self._catalog.connect() as connection:
            row = connection.execute(
                select(package_versions)
                .where(
                    package_versions.c.work_version_id == document_id,
                    package_versions.c.sha256 == package_sha256,
                )
                .order_by(package_versions.c.version.desc())
                .limit(1)
            ).mappings().one_or_none()
        return None if row is None else PackageVersionRecord.from_row(row)

    def register_published(
        self,
        work_version_id: str,
        processing_run_id: str,
        version: int,
        schema_version: str,
        quality: PackageQuality | str,
        storage_path: str,
        sha256: str,
        published_at: str,
    ) -> PackageVersionRecord:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        processing_run_id = validate_uuid(processing_run_id, "processing_run_id")
        if not isinstance(version, int) or isinstance(version, bool) or version <= 0:
            raise CatalogError("version must be a positive integer")
        schema_version = _required_text(schema_version, "schema_version")
        quality = quality if isinstance(quality, PackageQuality) else PackageQuality(quality)
        storage_path = validate_storage_path(storage_path)
        sha256 = validate_sha256(sha256)
        parse_rfc3339(published_at)
        package_id = stable_derivation_id(
            "package_version",
            {"work_version_id": work_version_id, "version": version, "sha256": sha256},
        )
        with catalog_operation("package registration"):
            with self._catalog.critical_transaction() as connection:
                existing = connection.execute(
                    select(package_versions).where(
                        (package_versions.c.id == package_id)
                        | (
                            (package_versions.c.work_version_id == work_version_id)
                            & (package_versions.c.version == version)
                        )
                    )
                ).mappings().one_or_none()
                values = {
                    "id": package_id,
                    "work_version_id": work_version_id,
                    "processing_run_id": processing_run_id,
                    "version": version,
                    "schema_version": schema_version,
                    "quality": quality.value,
                    "storage_path": storage_path,
                    "sha256": sha256,
                    "published_at": published_at,
                }
                if existing is not None:
                    if dict(existing) != values:
                        raise CatalogError("package version replay metadata conflicts")
                    return PackageVersionRecord.from_row(existing)
                run = connection.execute(
                    select(processing_runs).where(processing_runs.c.id == processing_run_id)
                ).mappings().one_or_none()
                if run is None or run["work_version_id"] != work_version_id or run["stage"] != "publication":
                    raise CatalogError("package publication run is missing or incompatible")
                if ProcessingRunState(run["state"]) is not ProcessingRunState.ACTIVE:
                    raise CatalogError("package publication run must be active")
                connection.execute(insert(package_versions).values(**values))
                connection.execute(
                    update(processing_runs)
                    .where(processing_runs.c.id == processing_run_id)
                    .values(state="succeeded", finished_at=published_at)
                )
                return PackageVersionRecord.from_row(values)


__all__ = ("PackageVersionRepository",)
