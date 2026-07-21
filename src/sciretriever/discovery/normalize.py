"""Pure normalization of raw discovery provider records."""

from __future__ import annotations

from html import unescape
from html.parser import HTMLParser
import unicodedata
from typing import Iterable

from sciretriever.core.contracts import CandidateMetadata, Identifier
from sciretriever.discovery.models import Candidate, ProviderRecord


_IDENTIFIER_PRECEDENCE = {"doi": 0, "pmid": 1, "arxiv": 2, "url": 3}


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def clean_text(value: str | None) -> str | None:
    """Return deterministic plain text, or None when no visible text remains."""
    if value is None:
        return None
    parser = _TextExtractor()
    parser.feed(unescape(value))
    parser.close()
    normalized = unicodedata.normalize("NFKC", " ".join(parser.parts))
    without_controls = "".join(
        " " if unicodedata.category(character).startswith("C") else character
        for character in normalized
    )
    cleaned = " ".join(without_controls.split())
    return cleaned or None


def _stable_unique(values: tuple[str, ...]) -> tuple[str, ...]:
    result: list[str] = []
    seen: set[str] = set()
    for raw_value in values:
        value = clean_text(raw_value)
        if value is None:
            continue
        key = value.casefold()
        if key not in seen:
            seen.add(key)
            result.append(value)
    return tuple(result)


def identifier_sort_key(identifier: Identifier) -> tuple[int, str, str]:
    return (
        _IDENTIFIER_PRECEDENCE.get(identifier.namespace, 4),
        identifier.namespace,
        identifier.value,
    )


def normalize_record(record: ProviderRecord) -> Candidate | None:
    """Normalize one provider record, dropping only wholly unusable records."""
    identifiers: set[Identifier] = set()
    for namespace, value in record.raw_identifiers:
        try:
            identifiers.add(Identifier(namespace, value))
        except (TypeError, ValueError):
            continue

    metadata = CandidateMetadata(
        title=clean_text(record.title),
        abstract=clean_text(record.abstract),
        authors=_stable_unique(record.authors),
        year=record.year,
        venue=clean_text(record.venue),
        keywords=_stable_unique(record.keywords),
    )
    ordered_identifiers = tuple(sorted(identifiers, key=identifier_sort_key))
    if metadata.title is None and not ordered_identifiers:
        return None
    provider = clean_text(record.provider)
    if provider is None:
        return None
    return Candidate(provider, record.rank, ordered_identifiers, metadata)


def normalize_records(records: Iterable[ProviderRecord]) -> tuple[Candidate, ...]:
    """Normalize records while retaining their provider result order."""
    return tuple(
        candidate
        for record in records
        if (candidate := normalize_record(record)) is not None
    )


__all__ = ("clean_text", "identifier_sort_key", "normalize_record", "normalize_records")
