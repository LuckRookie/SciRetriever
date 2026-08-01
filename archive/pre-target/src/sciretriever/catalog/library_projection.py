"""Safe public library result contracts and row projection."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Connection, select, union_all

from sciretriever.catalog.models import (
    authors, authorships, current_analyses, generated_work_version_tags,
    manual_work_tags, tags, work_version_identifiers,
)
from sciretriever.catalog.repository import canonical_json
from .library_reference_projection import ReadingReference
from sciretriever.core.contracts import Identifier
from sciretriever.core.public_identifiers import (
    PUBLIC_IDENTIFIER_NAMESPACES, public_identifier_sort_key,
)


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
    identifiers: tuple[Identifier, ...]
    authors: tuple[str, ...]
    tags: tuple[str, ...]
    light_content: tuple[str, ...] = ()
    references: tuple[ReadingReference, ...] | None = None

    def to_dict(self) -> dict[str, object]:
        value: dict[str, object] = {
            "abstract": self.abstract, "article_number": self.article_number,
            "authors": list(self.authors), "is_preferred": self.is_preferred,
            "identifiers": [value.to_dict() for value in self.identifiers],
            "language": self.language, "light_content": list(self.light_content),
            "open_access_status": self.open_access_status, "pages": self.pages,
            "preferred_work_version_id": self.preferred_work_version_id,
            "publication_date": self.publication_date,
            "publication_year": self.publication_year, "publisher": self.publisher,
            "tags": list(self.tags), "title": self.title, "venue": self.venue,
            "version_class": self.version_class, "volume": self.volume,
            "work_id": self.work_id, "work_type": self.work_type,
            "work_version_id": self.work_version_id,
        }
        if self.references is not None:
            value["references"] = [reference.to_dict() for reference in self.references]
        return value


@dataclass(frozen=True, slots=True)
class LibraryResult:
    items: tuple[LibraryItem, ...]

    def to_rows(self) -> tuple[dict[str, object], ...]:
        return tuple(item.to_dict() for item in self.items)

    def to_json(self) -> str:
        return canonical_json(list(self.to_rows()))

    def to_jsonl(self) -> str:
        return "".join(f"{canonical_json(row)}\n" for row in self.to_rows())


def project_item(
    connection: Connection,
    row: Any,
    include_light_content: bool,
    references: tuple[ReadingReference, ...] | None = None,
) -> LibraryItem:
    version_id = row["id"]
    author_names = tuple(connection.execute(
        select(authors.c.display_name).join(
            authorships, authorships.c.author_id == authors.c.id
        ).where(authorships.c.work_version_id == version_id).order_by(
            authorships.c.position, authorships.c.id
        )
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
    identifiers = tuple(sorted((
        Identifier(value.namespace, value.value)
        for value in connection.execute(select(
            work_version_identifiers.c.namespace, work_version_identifiers.c.value,
        ).where(
            work_version_identifiers.c.work_version_id == version_id,
            work_version_identifiers.c.namespace.in_(PUBLIC_IDENTIFIER_NAMESPACES),
        ))
    ), key=public_identifier_sort_key))
    content: tuple[str, ...] = ()
    if include_light_content:
        values: list[str] = []
        payload = connection.execute(select(current_analyses.c.content_json).where(
            current_analyses.c.work_version_id == version_id
        )).scalar_one_or_none()
        decoded = None if payload is None else json.loads(payload)
        if isinstance(decoded, dict) and isinstance(decoded.get("sections"), list):
            for section in decoded["sections"]:
                if (isinstance(section, dict)
                        and isinstance(section.get("content"), str)
                        and section["content"].strip()):
                    values.append(section["content"])
        content = tuple(dict.fromkeys(values))
    preferred_id = row["preferred_work_version_id"]
    if preferred_id is None:
        raise ValueError("Work has no preferred WorkVersion")
    return LibraryItem(
        work_id=row["work_id"], work_version_id=version_id,
        preferred_work_version_id=preferred_id, is_preferred=version_id == preferred_id,
        version_class=row["version_class"], title=row["title"], abstract=row["abstract"],
        language=row["language"], work_type=row["work_type"],
        publication_date=row["publication_date"], publication_year=row["publication_year"],
        publisher=row["publisher_name"], venue=row["venue_name"], volume=row["volume"],
        issue=row["issue"], pages=row["pages"], article_number=row["article_number"],
        open_access_status=row["open_access_status"], identifiers=identifiers,
        authors=author_names, tags=tag_names, light_content=content, references=references,
    )


__all__ = ("LibraryItem", "LibraryResult", "project_item")
