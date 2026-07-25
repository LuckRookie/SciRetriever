"""Read-only Work-centered library queries and safe canonical export."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import Select, exists, func, literal, or_, select, true

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.library import normalize_title
from sciretriever.catalog.models import (
    current_analyses,
    publishers,
    venues,
    version_references,
    work_version_identifiers,
    work_versions,
    works,
)
from sciretriever.catalog.library_projection import (
    LibraryItem, LibraryResult, project_item,
)
from sciretriever.catalog.library_query import apply_filters
from sciretriever.catalog.repository import _required_text, catalog_operation
from sciretriever.core.contracts import Identifier
from sciretriever.core.ids import validate_uuid


_DEFAULT_LIMIT = 100


def _limit(value: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError("limit must be an integer")
    if value <= 0:
        raise ValueError("limit must be positive")
    return value


def _include_light_content(value: bool) -> bool:
    if not isinstance(value, bool):
        raise TypeError("include_light_content must be a boolean")
    return value


def _literal_pattern(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


@dataclass(frozen=True, slots=True)
class LibraryFilters:
    author: str | None = None
    publication_year: int | None = None
    publisher: str | None = None
    venue: str | None = None
    tag: str | None = None

    def __post_init__(self) -> None:
        if self.publication_year is not None:
            if not isinstance(self.publication_year, int) or isinstance(self.publication_year, bool):
                raise TypeError("publication_year must be an integer")
            if self.publication_year < 0:
                raise ValueError("publication_year must be nonnegative")
        for field_name in ("author", "publisher", "venue", "tag"):
            value = getattr(self, field_name)
            if value is not None:
                _required_text(value, field_name)


class LibraryReadRepository:
    """Bounded, side-effect-free queries over canonical library projections."""

    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine):
            raise TypeError("catalog must be a CatalogEngine")
        self._catalog = catalog

    def exact_lookup(
        self,
        *,
        doi: str | None = None,
        title: str | None = None,
        work_id: str | None = None,
        work_version_id: str | None = None,
        include_light_content: bool = False,
        limit: int = _DEFAULT_LIMIT,
    ) -> LibraryResult:
        selectors = tuple(value is not None for value in (doi, title, work_id, work_version_id))
        if sum(selectors) != 1:
            raise ValueError("exact lookup requires exactly one selector")
        checked_limit = _limit(limit)
        include_light_content = _include_light_content(include_light_content)
        if doi is not None:
            normalized_doi = Identifier("doi", doi).value
            statement = self._base_select(preferred_only=False).where(exists(
                select(literal(1)).select_from(work_version_identifiers).where(
                    work_version_identifiers.c.work_version_id == work_versions.c.id,
                    work_version_identifiers.c.namespace == "doi",
                    work_version_identifiers.c.value == normalized_doi,
                )
            ))
        elif title is not None:
            titled_versions = work_versions.alias("titled_versions")
            statement = self._base_select().where(exists(
                select(literal(1)).select_from(titled_versions).where(
                    titled_versions.c.work_id == works.c.id,
                    titled_versions.c.normalized_title == normalize_title(title),
                )
            ))
        elif work_id is not None:
            statement = self._base_select().where(works.c.id == validate_uuid(work_id, "work_id"))
        else:
            assert work_version_id is not None
            statement = self._base_select(preferred_only=False).where(
                work_versions.c.id == validate_uuid(work_version_id, "work_version_id")
            )
        return self._execute(statement, checked_limit, include_light_content)

    def search(
        self,
        keyword: str | None = None,
        *,
        filters: LibraryFilters | None = None,
        include_light_content: bool = False,
        limit: int = _DEFAULT_LIMIT,
    ) -> LibraryResult:
        checked_limit = _limit(limit)
        if filters is not None and not isinstance(filters, LibraryFilters):
            raise TypeError("filters must be LibraryFilters")
        include_light_content = _include_light_content(include_light_content)
        statement = self._base_select()
        if keyword is not None:
            pattern = _literal_pattern(_required_text(keyword, "keyword").casefold())
            analysis_sections = func.json_each(
                current_analyses.c.content_json, "$.sections"
            ).table_valued("value").alias("analysis_sections")
            statement = statement.where(or_(
                func.lower(work_versions.c.title).like(pattern, escape="\\"),
                func.lower(work_versions.c.abstract).like(pattern, escape="\\"),
                exists(
                    select(literal(1))
                    .select_from(current_analyses.join(analysis_sections, true()))
                    .where(
                        current_analyses.c.work_version_id == work_versions.c.id,
                        func.lower(
                            func.json_extract(
                                analysis_sections.c.value, "$.content"
                            )
                        ).like(pattern, escape="\\"),
                    )
                ),
            ))
        if filters is not None:
            statement = apply_filters(statement, filters)
        return self._execute(statement, checked_limit, include_light_content)

    def references(
        self,
        *,
        work_id: str | None = None,
        work_version_id: str | None = None,
        include_light_content: bool = False,
        limit: int = _DEFAULT_LIMIT,
    ) -> LibraryResult:
        source_version = self._source_version(work_id, work_version_id)
        include_light_content = _include_light_content(include_light_content)
        statement = self._base_select().join(
            version_references,
            version_references.c.cited_work_id == works.c.id,
        ).where(version_references.c.citing_work_version_id == source_version)
        return self._execute(
            statement.order_by(version_references.c.reference_order, works.c.id),
            _limit(limit), include_light_content, preserve_order=True,
        )

    def cited_by(
        self,
        work_id: str,
        *,
        include_light_content: bool = False,
        limit: int = _DEFAULT_LIMIT,
    ) -> LibraryResult:
        target_id = validate_uuid(work_id, "work_id")
        include_light_content = _include_light_content(include_light_content)
        citing_versions = work_versions.alias("citing_versions")
        statement = self._base_select().where(exists(
            select(literal(1)).select_from(
                citing_versions.join(
                    version_references,
                    version_references.c.citing_work_version_id == citing_versions.c.id,
                )
            ).where(
                citing_versions.c.work_id == works.c.id,
                version_references.c.cited_work_id == target_id,
            )
        ))
        return self._execute(statement, _limit(limit), include_light_content)

    @staticmethod
    def _base_select(*, preferred_only: bool = True) -> Select[Any]:
        statement = select(
            works.c.id.label("work_id"),
            works.c.preferred_work_version_id,
            work_versions,
            publishers.c.canonical_name.label("publisher_name"),
            venues.c.canonical_name.label("venue_name"),
        ).select_from(
            works.join(work_versions, work_versions.c.work_id == works.c.id)
            .outerjoin(publishers, publishers.c.id == work_versions.c.publisher_id)
            .outerjoin(venues, venues.c.id == work_versions.c.venue_id)
        )
        if preferred_only:
            statement = statement.where(work_versions.c.id == works.c.preferred_work_version_id)
        return statement

    def _source_version(self, work_id: str | None, work_version_id: str | None) -> str:
        if (work_id is None) == (work_version_id is None):
            raise ValueError("references requires exactly one Work or WorkVersion ID")
        if work_version_id is not None:
            version_id = validate_uuid(work_version_id, "work_version_id")
            with self._catalog.connect() as connection:
                present = connection.execute(select(work_versions.c.id).where(
                    work_versions.c.id == version_id
                )).scalar_one_or_none()
            return version_id if present is not None else ""
        assert work_id is not None
        validated = validate_uuid(work_id, "work_id")
        with self._catalog.connect() as connection:
            preferred = connection.execute(select(works.c.preferred_work_version_id).where(
                works.c.id == validated
            )).scalar_one_or_none()
        return "" if preferred is None else preferred

    def _execute(
        self,
        statement: Select[Any],
        limit: int,
        include_light_content: bool,
        *,
        preserve_order: bool = False,
    ) -> LibraryResult:
        if not preserve_order:
            statement = statement.order_by(work_versions.c.normalized_title, works.c.id, work_versions.c.id)
        with catalog_operation("library read"):
            with self._catalog.connect() as connection:
                rows = connection.execute(statement.distinct().limit(limit)).mappings().all()
                items = tuple(
                    project_item(connection, row, include_light_content)
                    for row in rows
                )
        return LibraryResult(items)

__all__ = ("LibraryFilters", "LibraryItem", "LibraryReadRepository", "LibraryResult")
