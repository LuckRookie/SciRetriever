"""Read-only Work-centered library queries and safe canonical export."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Connection, Select, and_, exists, func, literal, or_, select, union_all

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.library import normalize_title
from sciretriever.catalog.models import (
    authors,
    authorships,
    generated_work_version_tags,
    light_structures,
    manual_work_tags,
    publisher_aliases,
    publishers,
    tag_aliases,
    tags,
    venue_aliases,
    venues,
    version_references,
    work_version_identifiers,
    work_versions,
    works,
)
from sciretriever.catalog.repository import _required_text, canonical_json, catalog_operation
from sciretriever.core.contracts import Identifier
from sciretriever.core.ids import validate_uuid


_DEFAULT_LIMIT = 100
_LIGHT_TEXT_KEYS = ("summary", "markdown", "text")


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


def _normalized_author(value: str) -> str:
    return _required_text(value, "author").casefold()


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


@dataclass(frozen=True, slots=True)
class LibraryItem:
    work_id: str
    work_version_id: str
    preferred_work_version_id: str
    is_preferred: bool
    version_class: str
    title: str
    abstract: str | None
    language: str | None
    work_type: str | None
    publication_date: str | None
    publication_year: int | None
    publisher: str | None
    venue: str | None
    volume: str | None
    issue: str | None
    pages: str | None
    article_number: str | None
    open_access_status: str | None
    authors: tuple[str, ...]
    tags: tuple[str, ...]
    light_content: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "abstract": self.abstract,
            "article_number": self.article_number,
            "authors": list(self.authors),
            "is_preferred": self.is_preferred,
            "language": self.language,
            "light_content": list(self.light_content),
            "open_access_status": self.open_access_status,
            "pages": self.pages,
            "preferred_work_version_id": self.preferred_work_version_id,
            "publication_date": self.publication_date,
            "publication_year": self.publication_year,
            "publisher": self.publisher,
            "tags": list(self.tags),
            "title": self.title,
            "venue": self.venue,
            "version_class": self.version_class,
            "volume": self.volume,
            "work_id": self.work_id,
            "work_type": self.work_type,
            "work_version_id": self.work_version_id,
        }


@dataclass(frozen=True, slots=True)
class LibraryResult:
    items: tuple[LibraryItem, ...]

    def to_rows(self) -> tuple[dict[str, object], ...]:
        return tuple(item.to_dict() for item in self.items)

    def to_json(self) -> str:
        return canonical_json(list(self.to_rows()))

    def to_jsonl(self) -> str:
        return "".join(f"{canonical_json(row)}\n" for row in self.to_rows())


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
            identified_versions = work_versions.alias("identified_versions")
            statement = self._base_select().where(exists(
                select(literal(1)).select_from(
                    work_version_identifiers.join(
                        identified_versions,
                        identified_versions.c.id == work_version_identifiers.c.work_version_id,
                    )
                ).where(
                    identified_versions.c.work_id == works.c.id,
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
            light_matches = [
                func.lower(func.json_extract(light_structures.c.content_json, f"$.{key}"))
                .like(pattern, escape="\\")
                for key in _LIGHT_TEXT_KEYS
            ]
            statement = statement.where(or_(
                func.lower(work_versions.c.title).like(pattern, escape="\\"),
                func.lower(work_versions.c.abstract).like(pattern, escape="\\"),
                exists(select(literal(1)).where(
                    light_structures.c.work_version_id == work_versions.c.id,
                    light_structures.c.kind == "summary",
                    or_(*light_matches),
                )),
            ))
        if filters is not None:
            statement = self._apply_filters(statement, filters)
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

    @staticmethod
    def _apply_filters(statement: Select[Any], filters: LibraryFilters) -> Select[Any]:
        conditions = []
        if filters.author is not None:
            conditions.append(exists(select(literal(1)).select_from(
                authorships.join(authors, authors.c.id == authorships.c.author_id)
            ).where(
                authorships.c.work_version_id == work_versions.c.id,
                authors.c.normalized_name == _normalized_author(filters.author),
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
                    self._item(connection, row, include_light_content)
                    for row in rows
                )
        return LibraryResult(items)

    @staticmethod
    def _item(
        connection: Connection,
        row: Any,
        include_light_content: bool,
    ) -> LibraryItem:
        version_id = row["id"]
        author_names = tuple(connection.execute(
            select(authors.c.display_name)
            .join(authorships, authorships.c.author_id == authors.c.id)
            .where(authorships.c.work_version_id == version_id)
            .order_by(authorships.c.position, authorships.c.id)
        ).scalars())
        tag_query = union_all(
            select(tags.c.canonical_name).join(
                manual_work_tags, manual_work_tags.c.tag_id == tags.c.id
            ).where(manual_work_tags.c.work_id == row["work_id"]),
            select(tags.c.canonical_name).join(
                generated_work_version_tags,
                generated_work_version_tags.c.tag_id == tags.c.id,
            ).where(generated_work_version_tags.c.work_version_id == version_id),
        ).subquery()
        tag_names = tuple(connection.execute(
            select(tag_query.c.canonical_name).distinct().order_by(tag_query.c.canonical_name)
        ).scalars())
        content = ()
        if include_light_content:
            values: list[str] = []
            content_rows = connection.execute(select(light_structures.c.content_json).where(
                light_structures.c.work_version_id == version_id,
                light_structures.c.kind == "summary",
            ).order_by(light_structures.c.created_at, light_structures.c.id)).scalars()
            for content_json in content_rows:
                decoded = json.loads(content_json)
                if isinstance(decoded, dict):
                    for key in _LIGHT_TEXT_KEYS:
                        value = decoded.get(key)
                        if isinstance(value, str) and value.strip():
                            values.append(value)
            content = tuple(dict.fromkeys(values))
        preferred_id = row["preferred_work_version_id"]
        if preferred_id is None:
            raise ValueError("Work has no preferred WorkVersion")
        return LibraryItem(
            work_id=row["work_id"], work_version_id=version_id,
            preferred_work_version_id=preferred_id,
            is_preferred=version_id == preferred_id,
            version_class=row["version_class"], title=row["title"], abstract=row["abstract"],
            language=row["language"], work_type=row["work_type"],
            publication_date=row["publication_date"], publication_year=row["publication_year"],
            publisher=row["publisher_name"], venue=row["venue_name"], volume=row["volume"],
            issue=row["issue"], pages=row["pages"], article_number=row["article_number"],
            open_access_status=row["open_access_status"], authors=author_names,
            tags=tag_names, light_content=content,
        )


__all__ = ("LibraryFilters", "LibraryItem", "LibraryReadRepository", "LibraryResult")
