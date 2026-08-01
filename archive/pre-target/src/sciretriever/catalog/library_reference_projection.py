"""Bounded public reference projection for reading exports."""

from __future__ import annotations

from dataclasses import dataclass
import unicodedata
from typing import TypedDict

from sqlalchemy import Connection, select

from sciretriever.catalog.models import (
    version_references,
    work_version_identifiers,
    work_versions,
    works,
)
from sciretriever.core.contracts import Identifier
from sciretriever.core.public_identifiers import (
    PUBLIC_IDENTIFIER_NAMESPACES,
    public_identifier_sort_key,
)


MAX_CITATION_TEXT_LENGTH = 2048


class ReadingReferenceJson(TypedDict):
    citation_text: str | None
    identifiers: list[dict[str, str]]
    reference_order: int
    resolved_work_id: str | None


@dataclass(frozen=True, slots=True)
class ReadingReference:
    reference_order: int
    resolved_work_id: str | None
    identifiers: tuple[Identifier, ...]
    citation_text: str | None

    def to_dict(self) -> ReadingReferenceJson:
        return {
            "citation_text": self.citation_text,
            "identifiers": [identifier.to_dict() for identifier in self.identifiers],
            "reference_order": self.reference_order,
            "resolved_work_id": self.resolved_work_id,
        }


def _safe_citation_text(value: str) -> str:
    printable = "".join(
        " " if unicodedata.category(character).startswith("C") else character
        for character in value
    )
    return " ".join(printable.split())[:MAX_CITATION_TEXT_LENGTH]


def _public_identifiers(
    connection: Connection,
    cited_work_id: str | None,
    cited_namespace: str | None,
    cited_value: str | None,
) -> tuple[Identifier, ...]:
    identifiers: set[Identifier] = set()
    if (
        cited_namespace in PUBLIC_IDENTIFIER_NAMESPACES
        and cited_value is not None
    ):
        identifiers.add(Identifier(cited_namespace, cited_value))
    if cited_work_id is not None:
        preferred_version_id = connection.execute(
            select(works.c.preferred_work_version_id).where(works.c.id == cited_work_id)
        ).scalar_one_or_none()
        if preferred_version_id is not None:
            identifiers.update(
                Identifier(row.namespace, row.value)
                for row in connection.execute(
                    select(
                        work_version_identifiers.c.namespace,
                        work_version_identifiers.c.value,
                    ).where(
                        work_version_identifiers.c.work_version_id == preferred_version_id,
                        work_version_identifiers.c.namespace.in_(PUBLIC_IDENTIFIER_NAMESPACES),
                    )
                )
            )
    return tuple(sorted(identifiers, key=public_identifier_sort_key))


def project_reading_references(
    connection: Connection,
    source_work_version_id: str,
    limit: int,
) -> tuple[ReadingReference, ...]:
    source_work_id = connection.execute(
        select(work_versions.c.work_id).where(work_versions.c.id == source_work_version_id)
    ).scalar_one()
    rows = connection.execute(
        select(
            version_references.c.reference_order,
            version_references.c.cited_work_id,
            version_references.c.raw_reference,
            version_references.c.cited_namespace,
            version_references.c.cited_value,
        ).where(
            version_references.c.citing_work_version_id == source_work_version_id
        ).order_by(
            version_references.c.reference_order,
            version_references.c.id,
        ).limit(limit)
    )
    projected: list[ReadingReference] = []
    visited: set[tuple[str, str, str]] = set()
    for row in rows:
        if row.cited_work_id == source_work_id:
            continue
        citation_text = _safe_citation_text(row.raw_reference)
        key = (
            "work", row.cited_work_id, ""
        ) if row.cited_work_id is not None else (
            row.cited_namespace or "citation",
            row.cited_value or "",
            citation_text,
        )
        if key in visited:
            continue
        visited.add(key)
        projected.append(ReadingReference(
            reference_order=row.reference_order,
            resolved_work_id=row.cited_work_id,
            identifiers=_public_identifiers(
                connection, row.cited_work_id, row.cited_namespace, row.cited_value,
            ),
            citation_text=None if row.cited_work_id is not None else citation_text,
        ))
    return tuple(projected)


__all__ = ("MAX_CITATION_TEXT_LENGTH", "ReadingReference", "project_reading_references")
