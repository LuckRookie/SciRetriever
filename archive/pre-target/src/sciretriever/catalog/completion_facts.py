"""Read-only derivation of WorkVersion completion from catalog facts."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
import json

from sqlalchemy import select
from sqlalchemy.engine import Connection

from .current_promotion_alignment import PrimaryPdf, current_promotion_aligns
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.text import normalize_title
from sciretriever.catalog.models import (
    current_analyses,
    metadata_observations,
    provider_canonical_projections,
    raw_assets,
    work_version_assets,
    work_version_identifiers,
    work_versions,
)
from sciretriever.catalog.repository import catalog_operation
from sciretriever.core.ids import validate_uuid
from sciretriever.errors import CatalogError


class CompletionStage(StrEnum):
    METADATA_PENDING = "metadata_pending"
    ASSET_PENDING = "asset_pending"
    ANALYSIS_PENDING = "analysis_pending"
    COMPLETE = "complete"


@dataclass(frozen=True, slots=True)
class CompletionFacts:
    work_version_id: str
    stage: CompletionStage
    metadata_ready: bool
    primary_pdf_ready: bool
    analysis_ready: bool
    primary_pdf_id: str | None
    primary_pdf_sha256: str | None
    current_analysis_id: str | None
    current_revision: int


def _provider_title(connection: Connection, work_version_id: str) -> str | None:
    encoded = connection.execute(select(provider_canonical_projections.c.value_json).where(
        provider_canonical_projections.c.work_version_id == work_version_id,
        provider_canonical_projections.c.field_name == "title",
    )).scalar_one_or_none()
    if encoded is None:
        return None
    try:
        title = json.loads(encoded)
    except (TypeError, ValueError):
        return None
    return title.strip() if isinstance(title, str) and title.strip() else None


def _metadata_ready(connection: Connection, version) -> bool:
    title = _provider_title(connection, version.id)
    if title is None:
        return False
    title_observations = connection.execute(select(
        metadata_observations.c.provider,
        metadata_observations.c.value_json,
    ).where(
        metadata_observations.c.work_version_id == version.id,
        metadata_observations.c.field_name == "title",
    )).all()
    matching_provider_title = False
    for provider, value_json in title_observations:
        try:
            observed_title = json.loads(value_json)
        except (TypeError, ValueError):
            continue
        if provider != "acquisition" and observed_title == title:
            matching_provider_title = True
            break
    if not matching_provider_title:
        return False
    namespaces = set(connection.execute(select(work_version_identifiers.c.namespace).where(
        work_version_identifiers.c.work_version_id == version.id)).scalars())
    stable_identity = bool(namespaces.intersection({"doi", "arxiv", "pmcid", "pmid"}))
    provisional_title = bool(version.is_provisional) and normalize_title(title) == version.normalized_title
    return stable_identity or provisional_title


def _primary_pdf(connection: Connection, work_version_id: str) -> PrimaryPdf | None:
    rows = connection.execute(select(raw_assets.c.id, raw_assets.c.sha256).select_from(
        work_version_assets.join(raw_assets, raw_assets.c.id == work_version_assets.c.raw_asset_id)).where(
            work_version_assets.c.work_version_id == work_version_id,
            work_version_assets.c.asset_role == "primary_pdf",
            raw_assets.c.media_type == "application/pdf",
            raw_assets.c.format == "pdf",
        )).all()
    relation_count = connection.execute(select(work_version_assets.c.raw_asset_id).where(
        work_version_assets.c.work_version_id == work_version_id,
        work_version_assets.c.asset_role == "primary_pdf")).all()
    if len(relation_count) != 1 or len(rows) != 1:
        return None
    return PrimaryPdf(rows[0].id, rows[0].sha256)


def _stage(metadata_ready: bool, primary_ready: bool, analysis_ready: bool) -> CompletionStage:
    if not metadata_ready:
        return CompletionStage.METADATA_PENDING
    if not primary_ready:
        return CompletionStage.ASSET_PENDING
    if not analysis_ready:
        return CompletionStage.ANALYSIS_PENDING
    return CompletionStage.COMPLETE


def _derive_facts(connection: Connection, version) -> CompletionFacts:
    metadata_ready = _metadata_ready(connection, version)
    primary = _primary_pdf(connection, version.id) if metadata_ready else None
    current = connection.execute(select(current_analyses).where(
        current_analyses.c.work_version_id == version.id)).mappings().one_or_none()
    analysis_ready = bool(primary is not None and current is not None
                          and current_promotion_aligns(connection, version, primary, current))
    return CompletionFacts(
        work_version_id=version.id,
        stage=_stage(metadata_ready, primary is not None, analysis_ready),
        metadata_ready=metadata_ready,
        primary_pdf_ready=primary is not None,
        analysis_ready=analysis_ready,
        primary_pdf_id=None if primary is None else primary.id,
        primary_pdf_sha256=None if primary is None else primary.sha256,
        current_analysis_id=None if current is None else current.id,
        current_revision=0 if current is None else current.revision,
    )


class CompletionFactsRepository:
    """Derive one WorkVersion's completion facts from one SQLite snapshot."""

    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine):
            raise TypeError("catalog must be a CatalogEngine")
        self._catalog = catalog

    def get(self, work_version_id: str) -> CompletionFacts:
        version_id = validate_uuid(work_version_id, "work_version_id")
        with catalog_operation("completion facts lookup"):
            with self._catalog.connect() as connection:
                connection.exec_driver_sql("BEGIN")
                version = connection.execute(select(work_versions).where(
                    work_versions.c.id == version_id)).mappings().one_or_none()
                if version is None:
                    raise CatalogError(f"unknown WorkVersion: {version_id}")
                return _derive_facts(connection, version)

    def select_by_stage(self, stage: CompletionStage, limit: int) -> tuple[str, ...]:
        if not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0:
            raise CatalogError("completion fact selection limit must be positive")
        with catalog_operation("completion facts selection"):
            with self._catalog.connect() as connection:
                connection.exec_driver_sql("BEGIN")
                versions = connection.execute(select(work_versions).order_by(
                    work_versions.c.normalized_title, work_versions.c.id)).mappings()
                selected: list[str] = []
                for version in versions:
                    if _derive_facts(connection, version).stage == stage:
                        selected.append(version.id)
                        if len(selected) == limit:
                            break
        return tuple(selected)


__all__ = ("CompletionFacts", "CompletionFactsRepository", "CompletionStage")
