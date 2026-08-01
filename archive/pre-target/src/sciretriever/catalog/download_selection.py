"""Bounded WorkVersion selection and neutral acquisition input records."""

from __future__ import annotations

from dataclasses import dataclass
import json
from urllib.parse import urlsplit

from sqlalchemy import exists, literal, select

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.library_read import LibraryFilters, LibraryReadRepository
from sciretriever.catalog.models import (
    authors,
    authorships,
    metadata_observations,
    publishers,
    venues,
    work_version_assets,
    work_version_identifiers,
    work_versions,
    works,
)
from sciretriever.catalog.repository import catalog_operation
from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole
from sciretriever.core.ids import validate_uuid
from sciretriever.errors import CatalogError


@dataclass(frozen=True, slots=True)
class DownloadSelection:
    work_version_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class WorkVersionDownloadRecord:
    work_version_id: str
    work_id: str
    identifiers: tuple[Identifier, ...]
    title: str
    authors: tuple[str, ...]
    publication_year: int | None
    publisher: str | None
    venue: str | None
    direct_url: str | None


class WorkVersionDownloadRepository:
    """Select existing versions without creating or changing Works."""

    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine):
            raise TypeError("catalog must be a CatalogEngine")
        self._catalog = catalog
        self._library = LibraryReadRepository(catalog)

    def select_exact(
        self, *, work_version_id: str | None = None, work_id: str | None = None
    ) -> DownloadSelection:
        if (work_version_id is None) == (work_id is None):
            raise ValueError("exact download selection requires one Work or WorkVersion ID")
        result = self._library.exact_lookup(
            work_version_id=work_version_id,
            work_id=work_id,
            limit=1,
        )
        if not result.items:
            selector = work_version_id if work_version_id is not None else work_id
            raise CatalogError(f"download selector did not match an existing record: {selector}")
        return DownloadSelection(tuple(item.work_version_id for item in result.items))

    def select_library(
        self,
        query: str | None,
        *,
        filters: LibraryFilters,
        limit: int,
    ) -> DownloadSelection:
        result = self._library.search(query, filters=filters, limit=limit)
        return DownloadSelection(tuple(item.work_version_id for item in result.items))

    def select_all_missing_primary_pdf(self, *, limit: int) -> DownloadSelection:
        if not isinstance(limit, int) or isinstance(limit, bool):
            raise TypeError("missing primary PDF selection limit must be an integer")
        if limit <= 0:
            raise ValueError("missing primary PDF selection limit must be positive")
        statement = (
            select(work_versions.c.id)
            .where(~exists(select(literal(1)).where(
                work_version_assets.c.work_version_id == work_versions.c.id,
                work_version_assets.c.asset_role == AssetRole.PRIMARY_PDF.value,
            )))
            .order_by(work_versions.c.normalized_title, work_versions.c.id)
            .limit(limit)
        )
        with catalog_operation("missing primary PDF selection"):
            with self._catalog.connect() as connection:
                ids = tuple(connection.execute(statement).scalars())
        return DownloadSelection(ids)

    def get(self, work_version_id: str) -> WorkVersionDownloadRecord:
        version_id = validate_uuid(work_version_id, "work_version_id")
        statement = (
            select(
                work_versions,
                works.c.id.label("selected_work_id"),
                publishers.c.canonical_name.label("publisher_name"),
                venues.c.canonical_name.label("venue_name"),
            )
            .select_from(
                work_versions.join(works, works.c.id == work_versions.c.work_id)
                .outerjoin(publishers, publishers.c.id == work_versions.c.publisher_id)
                .outerjoin(venues, venues.c.id == work_versions.c.venue_id)
            )
            .where(work_versions.c.id == version_id)
        )
        with catalog_operation("WorkVersion download input lookup"):
            with self._catalog.connect() as connection:
                row = connection.execute(statement).mappings().one_or_none()
                if row is None:
                    raise CatalogError(f"unknown WorkVersion: {version_id}")
                identifier_rows = connection.execute(
                    select(
                        work_version_identifiers.c.namespace,
                        work_version_identifiers.c.value,
                    ).where(
                        work_version_identifiers.c.work_version_id == version_id
                    ).order_by(
                        work_version_identifiers.c.namespace,
                        work_version_identifiers.c.value,
                    )
                ).all()
                author_names = tuple(connection.execute(
                    select(authors.c.display_name)
                    .join(authorships, authorships.c.author_id == authors.c.id)
                    .where(authorships.c.work_version_id == version_id)
                    .order_by(authorships.c.position, authorships.c.id)
                ).scalars())
                locators = tuple(connection.execute(
                    select(metadata_observations.c.value_json)
                    .where(
                        metadata_observations.c.work_version_id == version_id,
                        metadata_observations.c.field_name.in_(("direct_url", "pdf_url")),
                    )
                    .order_by(
                        metadata_observations.c.provider,
                        metadata_observations.c.provider_record_id,
                        metadata_observations.c.id,
                    )
                ).scalars())
        direct_url = next(
            (
                value
                for encoded in locators
                if isinstance((value := json.loads(encoded)), str)
                and urlsplit(value).scheme == "https"
                and urlsplit(value).hostname
                and urlsplit(value).username is None
                and urlsplit(value).password is None
            ),
            None,
        )
        return WorkVersionDownloadRecord(
            version_id,
            row["selected_work_id"],
            tuple(Identifier(namespace, value) for namespace, value in identifier_rows),
            row["title"],
            author_names,
            row["publication_year"],
            row["publisher_name"],
            row["venue_name"],
            direct_url,
        )


__all__ = (
    "DownloadSelection",
    "WorkVersionDownloadRecord",
    "WorkVersionDownloadRepository",
)
