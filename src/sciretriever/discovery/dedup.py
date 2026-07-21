"""Deterministic in-batch deduplication and cross-provider metadata merge."""

from __future__ import annotations

from collections import defaultdict
from typing import Callable, Iterable, TypeVar
import unicodedata

from sciretriever.core.contracts import CandidateMetadata, Identifier
from sciretriever.discovery.models import Candidate, MergedCandidate
from sciretriever.discovery.normalize import identifier_sort_key


_STRONG_NAMESPACES = frozenset({"doi", "pmid", "arxiv"})
_FIELD_PROVIDER_ORDER = {
    "title": ("crossref", "europe pmc", "arxiv"),
    "abstract": ("europe pmc", "arxiv", "crossref"),
    "default": ("crossref", "europe pmc", "arxiv"),
}
T = TypeVar("T")


def _provider_key(provider: str) -> str:
    return " ".join(provider.casefold().replace("_", " ").replace("-", " ").split())


def _candidate_key(candidate: Candidate) -> tuple[object, ...]:
    metadata = candidate.metadata
    return (
        _provider_key(candidate.provider),
        candidate.provider,
        candidate.rank,
        tuple((item.namespace, item.value) for item in candidate.identifiers),
        metadata.title or "",
        metadata.abstract or "",
        metadata.authors,
        -1 if metadata.year is None else metadata.year,
        metadata.venue or "",
        metadata.keywords,
    )


def _choice_key(candidate: Candidate, field: str, value: object) -> tuple[object, ...]:
    provider = _provider_key(candidate.provider)
    ordered = _FIELD_PROVIDER_ORDER[field]
    try:
        priority = ordered.index(provider)
        custom = ""
    except ValueError:
        priority = len(ordered)
        custom = provider
    canonical = str(value).casefold() if not isinstance(value, tuple) else tuple(
        item.casefold() for item in value
    )
    return priority, custom, candidate.rank, canonical, str(value)


def _select(
    candidates: tuple[Candidate, ...],
    field: str,
    getter: Callable[[CandidateMetadata], T | None],
) -> T | None:
    choices = ((candidate, getter(candidate.metadata)) for candidate in candidates)
    present = ((candidate, value) for candidate, value in choices if value is not None)
    selected = min(present, key=lambda item: _choice_key(item[0], field, item[1]), default=None)
    return None if selected is None else selected[1]


def _merge_keywords(candidates: tuple[Candidate, ...]) -> tuple[str, ...]:
    spellings: dict[str, list[tuple[Candidate, str]]] = defaultdict(list)
    for candidate in candidates:
        for keyword in candidate.metadata.keywords:
            spellings[keyword.casefold()].append((candidate, keyword))
    preferred = (
        min(values, key=lambda item: _choice_key(item[0], "default", item[1]))[1]
        for values in spellings.values()
    )
    return tuple(sorted(preferred, key=lambda value: (value.casefold(), value)))


def _strong_values(candidates: tuple[Candidate, ...]) -> dict[str, set[str]]:
    values = {namespace: set() for namespace in _STRONG_NAMESPACES}
    for candidate in candidates:
        for identifier in candidate.identifiers:
            if identifier.namespace in values:
                values[identifier.namespace].add(identifier.value)
    return values


def _normalized_match_key(value: str) -> str | None:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    without_punctuation = "".join(
        " " if unicodedata.category(character)[0] in {"P", "S"} else character
        for character in normalized
    )
    key = " ".join(without_punctuation.split())
    return key or None


def _title_key(candidates: tuple[Candidate, ...]) -> str | None:
    title = _select(candidates, "title", lambda metadata: metadata.title)
    return None if title is None else _normalized_match_key(title)


def _normalized_authors(candidates: tuple[Candidate, ...]) -> set[str]:
    return {
        key
        for candidate in candidates
        for author in candidate.metadata.authors
        if (key := _normalized_match_key(author)) is not None
    }


def _has_author_corroboration(
    components: list[tuple[Candidate, ...]], indexes: list[int]
) -> bool:
    identifier_components = [
        components[index]
        for index in indexes
        if any(candidate.identifiers for candidate in components[index])
    ]
    if len(identifier_components) < 2:
        return True
    author_sets = [_normalized_authors(component) for component in identifier_components]
    return bool(author_sets[0].intersection(*author_sets[1:]))


def _identifier_components(candidates: tuple[Candidate, ...]) -> list[tuple[Candidate, ...]]:
    parents = list(range(len(candidates)))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(left: int, right: int) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root != right_root:
            parents[max(left_root, right_root)] = min(left_root, right_root)

    owners: dict[Identifier, int] = {}
    for index, candidate in enumerate(candidates):
        for identifier in candidate.identifiers:
            owner = owners.setdefault(identifier, index)
            union(index, owner)

    grouped: dict[int, list[Candidate]] = defaultdict(list)
    for index, candidate in enumerate(candidates):
        grouped[find(index)].append(candidate)
    return [tuple(group) for _, group in sorted(grouped.items())]


def _merge_component(
    candidates: tuple[Candidate, ...], reasons: set[str]
) -> MergedCandidate:
    identifiers = tuple(
        sorted(
            {identifier for candidate in candidates for identifier in candidate.identifiers},
            key=identifier_sort_key,
        )
    )
    metadata = CandidateMetadata(
        title=_select(candidates, "title", lambda item: item.title),
        abstract=_select(candidates, "abstract", lambda item: item.abstract),
        authors=_select(candidates, "default", lambda item: item.authors or None) or (),
        year=_select(candidates, "default", lambda item: item.year),
        venue=_select(candidates, "default", lambda item: item.venue),
        keywords=_merge_keywords(candidates),
    )
    if metadata.abstract is None:
        reasons.add("missing_abstract")
    ordered_reasons = tuple(sorted(reasons))
    providers = tuple(sorted({candidate.provider for candidate in candidates}, key=lambda p: (p.casefold(), p)))
    source_ranks = tuple(
        sorted(
            {(candidate.provider, candidate.rank) for candidate in candidates},
            key=lambda item: (item[0].casefold(), item[0], item[1]),
        )
    )
    return MergedCandidate(
        identifiers,
        metadata,
        providers,
        source_ranks,
        bool(ordered_reasons),
        ordered_reasons,
    )


def deduplicate_candidates(candidates: Iterable[Candidate]) -> tuple[MergedCandidate, ...]:
    """Merge exact identifier components, then safe complete title groups."""
    ordered = tuple(sorted(set(candidates), key=_candidate_key))
    if not ordered:
        return ()
    components = _identifier_components(ordered)
    reasons = [set() for _ in components]
    for index, component in enumerate(components):
        if any(len(values) > 1 for values in _strong_values(component).values()):
            reasons[index].add("conflicting_strong_identifier")
        years = {candidate.metadata.year for candidate in component if candidate.metadata.year is not None}
        if len(years) > 1:
            reasons[index].add("conflicting_year")

    title_groups: dict[str, list[int]] = defaultdict(list)
    for index, component in enumerate(components):
        title = _title_key(component)
        if title is not None:
            title_groups[title].append(index)

    consumed: set[int] = set()
    merged: list[MergedCandidate] = []
    for title in sorted(title_groups):
        indexes = title_groups[title]
        if len(indexes) < 2:
            continue
        group = tuple(candidate for index in indexes for candidate in components[index])
        strong_conflict = any(len(values) > 1 for values in _strong_values(group).values())
        years = {candidate.metadata.year for candidate in group if candidate.metadata.year is not None}
        author_corroboration = _has_author_corroboration(components, indexes)
        if strong_conflict or len(years) > 1 or not author_corroboration:
            for index in indexes:
                reasons[index].add("ambiguous_title_match")
            continue
        merged.append(_merge_component(group, set().union(*(reasons[index] for index in indexes))))
        consumed.update(indexes)

    merged.extend(
        _merge_component(component, reasons[index])
        for index, component in enumerate(components)
        if index not in consumed
    )
    return tuple(sorted(merged, key=_merged_key))


def _merged_key(candidate: MergedCandidate) -> tuple[object, ...]:
    return (
        tuple((item.namespace, item.value) for item in candidate.identifiers),
        candidate.metadata.title.casefold() if candidate.metadata.title else "",
        candidate.providers,
        candidate.source_ranks,
    )


merge_candidates = deduplicate_candidates


__all__ = ("deduplicate_candidates", "merge_candidates")
