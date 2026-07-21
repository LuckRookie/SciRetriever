"""Neutral immutable records and mapping for legacy Paper-shaped rows."""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Mapping

from sciretriever.core.contracts import CandidateMetadata, Identifier


def _optional_text(value: object, name: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError(f"legacy {name} must be a string or null")
    normalized = " ".join(value.split())
    return normalized or None


def _string_values(value: object, name: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as error:
            raise ValueError(f"legacy {name} must be a JSON array") from error
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise TypeError(f"legacy {name} must be an array of strings")
    return tuple(item for item in (_optional_text(item, name) for item in value) if item)


@dataclass(frozen=True, slots=True)
class LegacyPaperRecord:
    row_id: int
    source_id: str
    identifiers: tuple[Identifier, ...]
    metadata: CandidateMetadata
    pdf_path: str | None


class LegacyPaperAdapter:
    """Map only approved neutral fields from a Paper-shaped row."""

    @staticmethod
    def map(row: Mapping[str, object], source_id: str) -> LegacyPaperRecord:
        if not isinstance(source_id, str) or not source_id.strip():
            raise ValueError("legacy source id must not be blank")
        row_id = row.get("id")
        if not isinstance(row_id, int) or isinstance(row_id, bool) or row_id < 0:
            raise ValueError("legacy paper id must be a nonnegative integer")
        year = row.get("pub_year")
        if year is not None and (not isinstance(year, int) or isinstance(year, bool)):
            raise TypeError("legacy pub_year must be an integer or null")
        identifiers = [Identifier("legacy-paper", f"{source_id.strip()}:{row_id}")]
        doi = _optional_text(row.get("doi"), "doi")
        url = _optional_text(row.get("url"), "url")
        if doi:
            identifiers.append(Identifier("doi", doi))
        if url:
            identifiers.append(Identifier("url", url))
        return LegacyPaperRecord(
            row_id=row_id,
            source_id=source_id.strip(),
            identifiers=tuple(identifiers),
            metadata=CandidateMetadata(
                title=_optional_text(row.get("title"), "title"),
                abstract=_optional_text(row.get("abstract"), "abstract"),
                authors=_string_values(row.get("authors"), "authors"),
                year=year,
                venue=_optional_text(row.get("journal"), "journal"),
                keywords=_string_values(row.get("keywords"), "keywords"),
            ),
            pdf_path=_optional_text(row.get("pdf_path"), "pdf_path"),
        )


__all__ = ("LegacyPaperAdapter", "LegacyPaperRecord")
