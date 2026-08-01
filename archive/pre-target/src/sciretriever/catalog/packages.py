"""Source resolution and durable package-version catalog registration."""

from __future__ import annotations

import json

from sqlalchemy import case, select

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import asset_intents, current_analyses, normalized_artifacts, processing_runs, raw_assets, work_version_assets, work_version_identifiers, works
from sciretriever.catalog.records import AssetIntentRecord, NormalizedArtifactRecord, ProcessingRunRecord, RawAssetRecord, WorkVersionAssetRecord
from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetIntentState
from sciretriever.core.ids import validate_uuid
from sciretriever.core.package import CurrentAnalysisSnapshot
from sciretriever.errors import CatalogError

from .package_versions import PackageVersionRepository


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
        selections = sum(value is not None for value in (work_id, raw_asset_id, work_version_id))
        if selections != 1 and not (raw_asset_id is not None and work_version_id is not None and work_id is None):
            raise ValueError("provide exactly one Work, WorkVersion, or RawAsset selection")
        if work_version_id is not None and raw_asset_id is None:
            work_version_id = validate_uuid(work_version_id, "work_version_id")
            with self._catalog.connect() as connection:
                found = connection.execute(
                    select(work_version_assets.c.work_version_id)
                    .where(work_version_assets.c.work_version_id == work_version_id)
                    .limit(1)
                ).scalar_one_or_none()
            if found is None:
                raise CatalogError(f"WorkVersion does not exist or has no assets: {work_version_id}")
            return work_version_id
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

    def current_analysis_snapshot(self, work_version_id: str) -> tuple[
        CurrentAnalysisSnapshot, tuple[NormalizedArtifactRecord, ...], tuple[ProcessingRunRecord, ...]
    ] | None:
        try:
            return self._load_current_analysis_snapshot(work_version_id)
        except CatalogError:
            raise
        except Exception as error:
            raise CatalogError("current analysis snapshot is incomplete or malformed") from error

    def _load_current_analysis_snapshot(self, work_version_id: str) -> tuple[
        CurrentAnalysisSnapshot, tuple[NormalizedArtifactRecord, ...], tuple[ProcessingRunRecord, ...]
    ] | None:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        with self._catalog.connect() as connection:
            current = connection.execute(select(current_analyses).where(
                current_analyses.c.work_version_id == work_version_id)).mappings().one_or_none()
            if current is None:
                return None
            analysis_run = connection.execute(select(processing_runs).where(
                processing_runs.c.id == current["processing_run_id"])).mappings().one()
            source_map_id = analysis_run["input_artifact_id"]
            artifact_rows = list(connection.execute(select(normalized_artifacts).where(normalized_artifacts.c.id.in_((
                current["parser_artifact_id"], source_map_id, current["analysis_artifact_id"]))).order_by(
                    normalized_artifacts.c.kind)).mappings().all())
            source_map = next(row for row in artifact_rows if row["id"] == source_map_id)
            source_provenance = json.loads(source_map["provenance_json"])
            parsing_run = connection.execute(select(processing_runs).where(
                processing_runs.c.id == source_provenance["parsing_run_id"])).mappings().one()
            normalization_run = connection.execute(select(processing_runs).where(
                processing_runs.c.id == source_provenance["normalization_run_id"])).mappings().one()
            parsing_details = json.loads(parsing_run["details_json"])
            extra_ids = tuple(parsing_details.get("output_artifact_ids", ()))
            present_ids = {row["id"] for row in artifact_rows}
            if extra_ids:
                artifact_rows.extend(connection.execute(select(normalized_artifacts).where(
                    normalized_artifacts.c.id.in_(tuple(identifier for identifier in extra_ids if identifier not in present_ids))
                )).mappings().all())
        by_id = {row["id"]: row for row in artifact_rows}
        snapshot = CurrentAnalysisSnapshot.from_current(
            current_id=current["id"], revision=current["revision"], run_id=current["processing_run_id"],
            parser_artifact_id=current["parser_artifact_id"], parser_artifact_sha256=by_id[current["parser_artifact_id"]]["sha256"],
            source_map_artifact_id=source_map_id, source_map_artifact_sha256=by_id[source_map_id]["sha256"],
            analysis_artifact_id=current["analysis_artifact_id"], analysis_artifact_sha256=by_id[current["analysis_artifact_id"]]["sha256"],
            content=json.loads(current["content_json"]), provenance=json.loads(current["provenance_json"]),
        )
        return snapshot, tuple(NormalizedArtifactRecord.from_row(row) for row in artifact_rows), (
            ProcessingRunRecord.from_row(parsing_run), ProcessingRunRecord.from_row(normalization_run),
            ProcessingRunRecord.from_row(analysis_run),
        )


__all__ = ("PackageSourceRepository", "PackageVersionRepository")
