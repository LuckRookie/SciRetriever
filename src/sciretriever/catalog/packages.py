"""Source resolution and durable package-version catalog registration."""

from __future__ import annotations

from sqlalchemy import case, insert, select, update

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import asset_intents, package_versions, processing_runs, raw_assets, work_version_assets, work_version_identifiers, works
from sciretriever.catalog.records import AssetIntentRecord, PackageVersionRecord, RawAssetRecord, WorkVersionAssetRecord
from sciretriever.catalog.repository import _append_event, _required_text, catalog_operation
from sciretriever.core.contracts import Identifier
from sciretriever.core.derivation import stable_derivation_id
from sciretriever.core.enums import AssetIntentState, PackageQuality, ProcessingRunState
from sciretriever.core.ids import validate_uuid
from sciretriever.core.timestamps import parse_rfc3339
from sciretriever.core.validation import validate_sha256, validate_storage_path, validate_token
from sciretriever.errors import CatalogError


class PackageSourceRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine):
            raise TypeError("catalog must be a CatalogEngine")
        self._catalog = catalog

    def resolve_work(
        self,
        *,
        work_id: str | None = None,
        raw_asset_id: str | None = None,
        work_version_id: str | None = None,
    ) -> str:
        if (work_id is None) == (raw_asset_id is None):
            raise ValueError("provide exactly one of work_id or raw_asset_id")
        if work_id is not None:
            if work_version_id is not None:
                raise ValueError("work_version_id only disambiguates raw_asset_id")
            work_id = validate_uuid(work_id, "work_id")
            with self._catalog.connect() as connection:
                found = connection.execute(select(works.c.preferred_work_version_id).where(works.c.id == work_id)).scalar_one_or_none()
            if found is None:
                raise CatalogError(f"work does not exist or has no preferred version: {work_id}")
            return found
        if raw_asset_id is None:
            raise ValueError("raw_asset_id is required")
        raw_asset_id = validate_uuid(raw_asset_id, "raw_asset_id")
        if work_version_id is not None:
            work_version_id = validate_uuid(work_version_id, "work_version_id")
        with self._catalog.connect() as connection:
            rows = connection.execute(select(work_version_assets.c.work_version_id).where(work_version_assets.c.raw_asset_id == raw_asset_id).order_by(work_version_assets.c.work_version_id)).scalars().all()
        unique = tuple(dict.fromkeys(rows))
        if work_version_id is not None:
            if work_version_id not in unique:
                raise CatalogError("raw asset is not linked to the selected WorkVersion")
            return work_version_id
        if len(unique) != 1:
            raise CatalogError("shared raw asset requires work_version_id")
        return unique[0]

    def list_files(self, work_version_id: str) -> tuple[tuple[WorkVersionAssetRecord, RawAssetRecord], ...]:
        work_version_id = validate_uuid(work_version_id, "work_id")
        with self._catalog.connect() as connection:
            rows = connection.execute(
                select(work_version_assets, raw_assets).join(raw_assets, raw_assets.c.id == work_version_assets.c.raw_asset_id).where(work_version_assets.c.work_version_id == work_version_id).order_by(work_version_assets.c.asset_role, raw_assets.c.sha256)
            ).mappings().all()
        return tuple(
            (WorkVersionAssetRecord.from_row(dict(row)), RawAssetRecord.from_row(dict(row)))
            for row in rows
        )

    def list_files_with_intent(
        self,
        work_version_id: str,
    ) -> tuple[tuple[WorkVersionAssetRecord, RawAssetRecord, AssetIntentRecord | None], ...]:
        """Return package sources with their work-specific immutable provenance."""

        work_version_id = validate_uuid(work_version_id, "work_id")
        resolved = []
        with self._catalog.connect() as connection:
            rows = connection.execute(
                select(work_version_assets, raw_assets)
                .join(raw_assets, raw_assets.c.id == work_version_assets.c.raw_asset_id)
                .where(work_version_assets.c.work_version_id == work_version_id)
                .order_by(work_version_assets.c.asset_role, raw_assets.c.sha256)
            ).mappings().all()
            for row in rows:
                link = WorkVersionAssetRecord.from_row(dict(row))
                raw = RawAssetRecord.from_row(dict(row))
                intent_row = connection.execute(
                    select(asset_intents)
                    .where(
                        asset_intents.c.work_version_id == link.work_version_id,
                        asset_intents.c.raw_asset_id == link.raw_asset_id,
                        asset_intents.c.asset_role == link.asset_role.value,
                        asset_intents.c.state.in_(
                            (
                                AssetIntentState.FINALIZED.value,
                                AssetIntentState.PUBLISHED.value,
                            )
                        ),
                    )
                    .order_by(
                        case(
                            (asset_intents.c.state == AssetIntentState.FINALIZED.value, 0),
                            else_=1,
                        ),
                        asset_intents.c.created_at,
                        asset_intents.c.id,
                    )
                    .limit(1)
                ).mappings().one_or_none()
                intent = None if intent_row is None else AssetIntentRecord.from_row(dict(intent_row))
                resolved.append((link, raw, intent))
        return tuple(resolved)

    def list_identifiers(self, work_version_id: str) -> tuple[Identifier, ...]:
        work_version_id = validate_uuid(work_version_id, "work_id")
        with self._catalog.connect() as connection:
            rows = connection.execute(
                select(
                    work_version_identifiers.c.namespace,
                    work_version_identifiers.c.value,
                )
                .where(
                    work_version_identifiers.c.work_version_id == work_version_id
                )
                .order_by(
                    work_version_identifiers.c.namespace,
                    work_version_identifiers.c.value,
                )
            ).all()
        return tuple(Identifier(namespace, value) for namespace, value in rows)


class PackageVersionRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine):
            raise TypeError("catalog must be a CatalogEngine")
        if catalog.read_only:
            raise CatalogError("PackageVersionRepository requires a writable catalog")
        self._catalog = catalog

    def get(self, package_id: str) -> PackageVersionRecord | None:
        package_id = validate_uuid(package_id, "package_id")
        with self._catalog.connect() as connection:
            row = connection.execute(select(package_versions).where(package_versions.c.id == package_id)).mappings().one_or_none()
        return None if row is None else PackageVersionRecord.from_row(row)

    def latest(self, work_version_id: str) -> PackageVersionRecord | None:
        work_version_id = validate_uuid(work_version_id, "work_id")
        with self._catalog.connect() as connection:
            row = connection.execute(select(package_versions).where(package_versions.c.work_version_id == work_version_id).order_by(package_versions.c.version.desc()).limit(1)).mappings().one_or_none()
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
        work_version_id = validate_uuid(work_version_id, "work_id")
        processing_run_id = validate_uuid(processing_run_id, "processing_run_id")
        if not isinstance(version, int) or isinstance(version, bool) or version <= 0:
            raise ValueError("version must be a positive integer")
        schema_version = _required_text(schema_version, "schema_version")
        quality = quality if isinstance(quality, PackageQuality) else PackageQuality(quality)
        storage_path = validate_storage_path(storage_path)
        sha256 = validate_sha256(sha256)
        parse_rfc3339(published_at)
        package_id = stable_derivation_id("package_version", {"work_version_id": work_version_id, "version": version, "sha256": sha256})
        with catalog_operation("package registration"):
            with self._catalog.critical_transaction() as connection:
                existing = connection.execute(select(package_versions).where((package_versions.c.id == package_id) | ((package_versions.c.work_version_id == work_version_id) & (package_versions.c.version == version)))).mappings().one_or_none()
                values = {
                    "id": package_id, "work_version_id": work_version_id, "processing_run_id": processing_run_id,
                    "version": version, "schema_version": schema_version, "quality": quality.value,
                    "storage_path": storage_path, "sha256": sha256, "published_at": published_at,
                }
                if existing is not None:
                    if dict(existing) != values:
                        raise CatalogError("package version replay metadata conflicts")
                    return PackageVersionRecord.from_row(existing)
                run = connection.execute(select(processing_runs).where(processing_runs.c.id == processing_run_id)).mappings().one_or_none()
                if run is None or run["work_version_id"] != work_version_id or run["stage"] != "publication":
                    raise CatalogError("package publication run is missing or incompatible")
                if ProcessingRunState(run["state"]) is not ProcessingRunState.ACTIVE:
                    raise CatalogError("package publication run must be active")
                connection.execute(insert(package_versions).values(**values))
                connection.execute(update(processing_runs).where(processing_runs.c.id == processing_run_id).values(state="succeeded", finished_at=published_at))
                _append_event(connection, subject_type="package_version", subject_id=package_id, event_type="package_version.published", details={"version": version})
                return PackageVersionRecord.from_row(values)


__all__ = ("PackageSourceRepository", "PackageVersionRepository")
