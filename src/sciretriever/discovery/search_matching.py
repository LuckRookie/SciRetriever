"""Deterministic identity grouping and canonical metadata selection."""

from __future__ import annotations

from collections.abc import Callable
from typing import TypeVar

from sciretriever.catalog.library import normalize_title
from sciretriever.core.contracts import CandidateMetadata, Identifier
from .search_records import ObservedMetadataRecord, raw_record_key


_Selected = TypeVar("_Selected")


def ambiguities(
    records: tuple[ObservedMetadataRecord, ...]
) -> tuple[frozenset[str], frozenset[Identifier]]:
    title_dois: dict[str, set[str]] = {}
    identifier_dois: dict[Identifier, set[str]] = {}
    for item in records:
        dois = {
            identifier.value
            for identifier in item.identifiers
            if identifier.namespace == "doi"
        }
        if not dois:
            continue
        if item.metadata.title is not None:
            title_dois.setdefault(normalize_title(item.metadata.title), set()).update(dois)
        for identifier in item.identifiers:
            if identifier.namespace != "doi":
                identifier_dois.setdefault(identifier, set()).update(dois)
    ambiguous_titles = {
        title for title, dois in title_dois.items() if len(dois) > 1
    }
    ambiguous_identifiers = {
        identifier for identifier, dois in identifier_dois.items() if len(dois) > 1
    }
    for item in records:
        if any(identifier.namespace == "doi" for identifier in item.identifiers):
            continue
        linked_dois: set[str] = set()
        title = (
            normalize_title(item.metadata.title)
            if item.metadata.title is not None
            else None
        )
        if title is not None:
            linked_dois.update(title_dois.get(title, ()))
        for identifier in item.identifiers:
            linked_dois.update(identifier_dois.get(identifier, ()))
        if len(linked_dois) > 1:
            if title is not None:
                ambiguous_titles.add(title)
            ambiguous_identifiers.update(
                identifier
                for identifier in item.identifiers
                if identifier.namespace != "doi"
            )
    return frozenset(ambiguous_titles), frozenset(ambiguous_identifiers)


def merge_groups(
    records: tuple[ObservedMetadataRecord, ...],
    precedence: tuple[str, ...],
    ambiguous_titles: frozenset[str],
    ambiguous_identifiers: frozenset[Identifier],
) -> tuple[tuple[ObservedMetadataRecord, ...], ...]:
    groups: list[list[ObservedMetadataRecord]] = []
    for record in records:
        matches = [
            index
            for index, group in enumerate(groups)
            if _records_match(record, group, ambiguous_titles, ambiguous_identifiers)
        ]
        if not matches:
            groups.append([record])
            continue
        combined = [record]
        for index in reversed(matches):
            combined.extend(groups.pop(index))
        groups.append(combined)
    order = {provider: index for index, provider in enumerate(precedence)}
    normalized_groups = [
        tuple(sorted(
            group,
            key=lambda item: (order[item.record.provider], raw_record_key(item.record)),
        ))
        for group in groups
    ]
    return tuple(sorted(
        normalized_groups,
        key=lambda group: (
            order[group[0].record.provider],
            group[0].record.rank,
            _group_key(group),
        ),
    ))


def canonical_metadata(group: tuple[ObservedMetadataRecord, ...]) -> CandidateMetadata:
    keywords = {
        keyword.casefold(): keyword
        for item in reversed(group)
        for keyword in item.metadata.keywords
    }
    return CandidateMetadata(
        title=_select(group, lambda item: item.metadata.title),
        abstract=_select(group, lambda item: item.metadata.abstract),
        authors=_select(group, lambda item: item.metadata.authors) or (),
        year=_select(group, lambda item: item.metadata.year),
        venue=_select(group, lambda item: item.metadata.venue),
        keywords=tuple(keywords[key] for key in sorted(keywords)),
    )


def _records_match(
    record: ObservedMetadataRecord,
    group: list[ObservedMetadataRecord],
    ambiguous_titles: frozenset[str],
    ambiguous_identifiers: frozenset[Identifier],
) -> bool:
    record_dois = {item.value for item in record.identifiers if item.namespace == "doi"}
    group_dois = {
        identifier.value
        for item in group
        for identifier in item.identifiers
        if identifier.namespace == "doi"
    }
    if record_dois and group_dois and record_dois != group_dois:
        return False
    identifiers = set(record.identifiers) - ambiguous_identifiers
    group_identifiers = {
        identifier
        for item in group
        for identifier in item.identifiers
        if identifier not in ambiguous_identifiers
    }
    if identifiers.intersection(group_identifiers):
        return True
    if record.metadata.title is None:
        return False
    title = normalize_title(record.metadata.title)
    if title in ambiguous_titles and (record_dois or group_dois):
        return False
    return all(
        item.metadata.title is not None
        and normalize_title(item.metadata.title) == title
        for item in group
    )


def _select(
    group: tuple[ObservedMetadataRecord, ...],
    getter: Callable[[ObservedMetadataRecord], _Selected | None],
) -> _Selected | None:
    for item in group:
        value = getter(item)
        if value is not None and value != ():
            return value
    return None


def _group_key(group: tuple[ObservedMetadataRecord, ...]) -> tuple[object, ...]:
    identifiers = tuple(sorted({
        (identifier.namespace, identifier.value)
        for item in group
        for identifier in item.identifiers
    }))
    title = next(
        (item.metadata.title for item in group if item.metadata.title is not None), ""
    )
    ranks = tuple((item.record.provider, item.record.rank) for item in group)
    return identifiers, title.casefold(), ranks


__all__ = ("ambiguities", "canonical_metadata", "merge_groups")
