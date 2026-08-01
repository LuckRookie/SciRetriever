"""Bounded selection of WorkVersions for current PDF analysis."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select

from sciretriever.catalog.completion_facts import CompletionFactsRepository, CompletionStage
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.library_read import LibraryFilters, LibraryReadRepository
from sciretriever.catalog.models import current_analyses, raw_assets, work_version_assets, work_versions
from sciretriever.core.enums import AssetRole
from sciretriever.core.ids import validate_uuid
from sciretriever.errors import CatalogError


@dataclass(frozen=True, slots=True)
class AnalysisSelection:
    work_version_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class WorkVersionAnalysisRecord:
    work_version_id: str
    primary_pdf_id: str | None
    current_id: str | None
    current_revision: int
    eligibility_reason: str | None


class WorkVersionAnalysisRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        self._catalog = catalog
        self._library = LibraryReadRepository(catalog)
        self._facts = CompletionFactsRepository(catalog)

    def _pending(self, ids: tuple[str, ...], *, force: bool) -> AnalysisSelection:
        if force or not ids:
            return AnalysisSelection(ids)
        with self._catalog.connect() as connection:
            current = set(connection.execute(select(current_analyses.c.work_version_id).where(
                current_analyses.c.work_version_id.in_(ids))).scalars())
        return AnalysisSelection(tuple(value for value in ids if value not in current))

    def select_exact(self, *, work_version_id: str | None = None, work_id: str | None = None,
                     force: bool = False) -> AnalysisSelection:
        if (work_version_id is None) == (work_id is None):
            raise ValueError("exact analysis selection requires one Work or WorkVersion ID")
        result = self._library.exact_lookup(work_version_id=work_version_id, work_id=work_id, limit=1)
        if not result.items:
            raise CatalogError("analysis selector did not match an existing record")
        return self._pending(tuple(item.work_version_id for item in result.items), force=force)

    def select_library(self, query: str | None, *, filters: LibraryFilters, limit: int,
                        force: bool = False) -> AnalysisSelection:
        result = self._library.search(query, filters=filters, limit=limit)
        ids = tuple(item.work_version_id for item in result.items)
        if force:
            return AnalysisSelection(ids)
        return AnalysisSelection(tuple(
            value for value in ids
            if self._facts.get(value).stage == CompletionStage.ANALYSIS_PENDING
        ))

    def select_all_pending(self, *, limit: int) -> AnalysisSelection:
        return AnalysisSelection(
            self._facts.select_by_stage(CompletionStage.ANALYSIS_PENDING, limit)
        )

    def select_all_current(self, *, limit: int, force: bool) -> AnalysisSelection:
        if not force:
            raise ValueError("all-current analysis selection requires force")
        statement = (select(work_versions.c.id).join(
            current_analyses, current_analyses.c.work_version_id == work_versions.c.id)
            .order_by(work_versions.c.normalized_title, work_versions.c.id).limit(limit))
        with self._catalog.connect() as connection:
            return AnalysisSelection(tuple(connection.execute(statement).scalars()))

    def get(self, work_version_id: str) -> WorkVersionAnalysisRecord:
        version_id = validate_uuid(work_version_id, "work_version_id")
        with self._catalog.connect() as connection:
            exists = connection.execute(select(work_versions.c.id).where(work_versions.c.id == version_id)).scalar_one_or_none()
            if exists is None:
                raise CatalogError(f"unknown WorkVersion: {version_id}")
            rows = connection.execute(select(raw_assets.c.id, raw_assets.c.media_type).select_from(
                work_version_assets.join(raw_assets, raw_assets.c.id == work_version_assets.c.raw_asset_id))
                .where(work_version_assets.c.work_version_id == version_id,
                       work_version_assets.c.asset_role == AssetRole.PRIMARY_PDF.value)
                .order_by(raw_assets.c.id)).all()
            current = connection.execute(select(current_analyses.c.id, current_analyses.c.revision).where(
                current_analyses.c.work_version_id == version_id)).one_or_none()
        eligible = tuple(row.id for row in rows if row.media_type == "application/pdf")
        reason = None
        if len(rows) == 0:
            reason = "primary_pdf_missing"
        elif len(rows) != 1 or len(eligible) != 1:
            reason = "primary_pdf_not_exactly_one_accepted_pdf"
        return WorkVersionAnalysisRecord(version_id, eligible[0] if reason is None else None,
            None if current is None else current.id, 0 if current is None else current.revision, reason)


__all__ = ("AnalysisSelection", "WorkVersionAnalysisRecord", "WorkVersionAnalysisRepository")
