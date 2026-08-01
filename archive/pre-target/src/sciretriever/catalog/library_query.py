"""SQL filter composition for read-only library queries."""

from __future__ import annotations

from typing import Any, Protocol
from sqlalchemy import Select, and_, exists, literal, or_, select

from sciretriever.catalog.text import normalize_title
from sciretriever.catalog.models import (
    authors, authorships, generated_work_version_tags, manual_work_tags,
    publisher_aliases, publishers, tag_aliases, tags, venue_aliases, venues,
    work_versions, works,
)


class LibraryFilterValues(Protocol):
    @property
    def author(self) -> str | None: ...

    @property
    def publication_year(self) -> int | None: ...

    @property
    def publisher(self) -> str | None: ...

    @property
    def venue(self) -> str | None: ...

    @property
    def tag(self) -> str | None: ...


def apply_filters(statement: Select[Any], filters: LibraryFilterValues) -> Select[Any]:
    conditions = []
    if filters.author is not None:
        conditions.append(exists(select(literal(1)).select_from(
            authorships.join(authors, authors.c.id == authorships.c.author_id)
        ).where(
            authorships.c.work_version_id == work_versions.c.id,
            authors.c.normalized_name == " ".join(filters.author.split()).casefold(),
        )))
    if filters.publication_year is not None:
        conditions.append(work_versions.c.publication_year == filters.publication_year)
    if filters.publisher is not None:
        normalized = normalize_title(filters.publisher)
        conditions.append(or_(
            publishers.c.normalized_name == normalized,
            exists(select(literal(1)).where(
                publisher_aliases.c.publisher_id == publishers.c.id,
                publisher_aliases.c.normalized_alias == normalized,
            )),
        ))
    if filters.venue is not None:
        normalized = normalize_title(filters.venue)
        conditions.append(or_(
            venues.c.normalized_name == normalized,
            exists(select(literal(1)).where(
                venue_aliases.c.venue_id == venues.c.id,
                venue_aliases.c.normalized_alias == normalized,
            )),
        ))
    if filters.tag is not None:
        normalized = normalize_title(filters.tag)
        tag_ids = select(tags.c.id).where(or_(
            tags.c.normalized_name == normalized,
            exists(select(literal(1)).where(
                tag_aliases.c.tag_id == tags.c.id,
                tag_aliases.c.normalized_alias == normalized,
            )),
        ))
        conditions.append(or_(
            exists(select(literal(1)).where(
                manual_work_tags.c.work_id == works.c.id,
                manual_work_tags.c.tag_id.in_(tag_ids),
            )),
            exists(select(literal(1)).where(
                generated_work_version_tags.c.work_version_id == work_versions.c.id,
                generated_work_version_tags.c.tag_id.in_(tag_ids),
            )),
        ))
    return statement.where(and_(*conditions)) if conditions else statement


__all__ = ("apply_filters",)
