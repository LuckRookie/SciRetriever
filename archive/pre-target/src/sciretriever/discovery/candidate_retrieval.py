"""Catalog-neutral metadata candidate normalization and identity matching."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from typing import TypeVar

from sciretriever.core.contracts import CandidateMetadata, Identifier
from .search_records import (
    normalize_candidate_observation,
    normalize_candidate_title,
)
from sciretriever.discovery.models import (
    CandidateObservation,
    CandidateRetrievalRequest,
    CandidateRetrievalResult,
    ProviderFailure,
    ProviderRecord,
    RetrievedCandidate,
)
from sciretriever.discovery.normalize import identifier_sort_key


_Selected = TypeVar("_Selected")


class CandidatePreparer:
    def prepare(
        self,
        request: CandidateRetrievalRequest,
        records: tuple[ProviderRecord, ...],
        failures: tuple[ProviderFailure, ...] = (),
        *,
        all_providers_failed: bool = False,
    ) -> CandidateRetrievalResult:
        observations = tuple(
            observation
            for record in records
            if (observation := normalize_candidate_observation(record)) is not None
            and _has_consistent_doi_identity(observation)
        )
        ambiguous_titles, ambiguous_identifiers = _ambiguities(observations)
        groups = _groups(
            observations,
            request.precedence,
            ambiguous_titles,
            ambiguous_identifiers,
        )
        candidates = tuple(
            candidate
            for group in groups
            if (candidate := _candidate(group, ambiguous_titles, ambiguous_identifiers))
            is not None
        )[: request.spec.limit]
        return CandidateRetrievalResult(
            candidates,
            tuple(sorted(failures, key=lambda item: (item.provider, item.category, item.message))),
            all_providers_failed,
        )

    def prepare_exact(
        self,
        records: tuple[ProviderRecord, ...],
        doi: str,
        precedence: tuple[str, ...],
    ) -> RetrievedCandidate | None:
        order = {provider: index for index, provider in enumerate(precedence)}
        observations = tuple(
            replace(
                observation,
                identifiers=tuple(
                    identifier
                    for identifier in observation.identifiers
                    if identifier.namespace != "doi" or identifier.value == doi
                ),
            )
            for record in records
            if (observation := normalize_candidate_observation(record)) is not None
            and _has_consistent_doi_identity(observation)
            and any(
                identifier.namespace == "doi" and identifier.value == doi
                for identifier in observation.identifiers
            )
        )
        group = tuple(sorted(observations, key=lambda item: _observation_key(item, order)))
        return _candidate(group, frozenset(), frozenset()) if group else None


def _has_consistent_doi_identity(observation: CandidateObservation) -> bool:
    return len({
        identifier.value
        for identifier in observation.identifiers
        if identifier.namespace == "doi"
    }) <= 1


def _ambiguities(
    observations: tuple[CandidateObservation, ...],
) -> tuple[frozenset[str], frozenset[Identifier]]:
    title_dois: dict[str, set[str]] = {}
    identifier_dois: dict[Identifier, set[str]] = {}
    for item in observations:
        dois = {value.value for value in item.identifiers if value.namespace == "doi"}
        if not dois:
            continue
        if item.metadata.title is not None:
            title_dois.setdefault(normalize_candidate_title(item.metadata.title), set()).update(dois)
        for identifier in item.identifiers:
            if identifier.namespace != "doi":
                identifier_dois.setdefault(identifier, set()).update(dois)
    titles = {title for title, dois in title_dois.items() if len(dois) > 1}
    identifiers = {
        identifier for identifier, dois in identifier_dois.items() if len(dois) > 1
    }
    for item in observations:
        if any(value.namespace == "doi" for value in item.identifiers):
            continue
        title = normalize_candidate_title(item.metadata.title) if item.metadata.title else None
        linked = set(title_dois.get(title, ())) if title else set()
        for identifier in item.identifiers:
            linked.update(identifier_dois.get(identifier, ()))
        if len(linked) > 1:
            if title:
                titles.add(title)
            identifiers.update(value for value in item.identifiers if value.namespace != "doi")
    return frozenset(titles), frozenset(identifiers)


def _groups(
    observations: tuple[CandidateObservation, ...],
    precedence: tuple[str, ...],
    ambiguous_titles: frozenset[str],
    ambiguous_identifiers: frozenset[Identifier],
) -> tuple[tuple[CandidateObservation, ...], ...]:
    order = {provider: index for index, provider in enumerate(precedence)}
    pending = sorted(observations, key=lambda item: _observation_key(item, order))
    groups: list[list[CandidateObservation]] = []
    for observation in pending:
        matches = [
            index for index, group in enumerate(groups)
            if _matches(observation, group, ambiguous_titles, ambiguous_identifiers)
        ]
        combined = [observation]
        for index in reversed(matches):
            combined.extend(groups.pop(index))
        groups.append(combined)
    normalized = [
        tuple(sorted(group, key=lambda item: _observation_key(item, order)))
        for group in groups
    ]
    return tuple(sorted(normalized, key=lambda group: _observation_key(group[0], order)))


def _matches(
    observation: CandidateObservation,
    group: list[CandidateObservation],
    ambiguous_titles: frozenset[str],
    ambiguous_identifiers: frozenset[Identifier],
) -> bool:
    dois = {item.value for item in observation.identifiers if item.namespace == "doi"}
    group_dois = {
        value.value for item in group for value in item.identifiers if value.namespace == "doi"
    }
    if dois and group_dois and dois != group_dois:
        return False
    safe = set(observation.identifiers) - ambiguous_identifiers
    group_safe = {value for item in group for value in item.identifiers} - ambiguous_identifiers
    if safe.intersection(group_safe):
        return True
    if observation.metadata.title is None:
        return False
    title = normalize_candidate_title(observation.metadata.title)
    if title in ambiguous_titles and (dois or group_dois):
        return False
    return all(
        item.metadata.title is not None
        and normalize_candidate_title(item.metadata.title) == title
        for item in group
    )


def _candidate(
    group: tuple[CandidateObservation, ...],
    ambiguous_titles: frozenset[str],
    ambiguous_identifiers: frozenset[Identifier],
) -> RetrievedCandidate | None:
    metadata = _canonical_metadata(group)
    if metadata.title is None:
        return None
    identifiers = tuple(sorted(
        {value for item in group for value in item.identifiers
         if value not in ambiguous_identifiers},
        key=identifier_sort_key,
    ))
    ambiguous = any(value in ambiguous_identifiers for item in group for value in item.identifiers)
    ambiguous = ambiguous or any(
        item.metadata.title is not None
        and normalize_candidate_title(item.metadata.title) in ambiguous_titles
        for item in group
    )
    return RetrievedCandidate(
        identifiers,
        metadata,
        _select(group, lambda item: item.publisher),
        _select(group, lambda item: item.publication_date),
        _select(group, lambda item: item.open_access_status),
        group,
        tuple(dict.fromkeys(item.provider for item in group)),
        tuple((item.provider, item.rank) for item in group),
        ("missing_abstract",) if metadata.abstract is None else (),
        ("conflicting DOI bridge evidence",) if ambiguous else (),
    )


def _canonical_metadata(group: tuple[CandidateObservation, ...]) -> CandidateMetadata:
    keywords = {word.casefold(): word for item in reversed(group) for word in item.metadata.keywords}
    return CandidateMetadata(
        _select(group, lambda item: item.metadata.title),
        _select(group, lambda item: item.metadata.abstract),
        _select(group, lambda item: item.metadata.authors) or (),
        _select(group, lambda item: item.metadata.year),
        _select(group, lambda item: item.metadata.venue),
        tuple(keywords[key] for key in sorted(keywords)),
    )


def _select(
    group: tuple[CandidateObservation, ...],
    getter: Callable[[CandidateObservation], _Selected | None],
) -> _Selected | None:
    return next((value for item in group if (value := getter(item)) not in (None, ())), None)


def _observation_key(
    item: CandidateObservation, order: dict[str, int]
) -> tuple[int, int, str, str]:
    identity = repr((item.identifiers, item.metadata, item.publisher,
                     item.publication_date, item.open_access_status))
    return order[item.provider], item.rank, item.provider_record_id, identity


__all__ = ("CandidateObservation", "CandidatePreparer", "CandidateRetrievalRequest",
           "CandidateRetrievalResult", "ProviderFailure", "RetrievedCandidate")
