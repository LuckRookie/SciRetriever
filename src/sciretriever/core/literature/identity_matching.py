from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Iterable

from sciretriever.core.literature.identity_metadata import metadata_json, prepare_observation
from sciretriever.model.literature import (
    BibliographicObservation,
    Identifier,
    IdentityRecord,
    InitialMetadata,
)

_SPACE = re.compile(r"\s+")
_ROLE_ORDER = {"formal": 0, "accepted-manuscript": 1, "preprint": 2, "other": 3}
_IDENTIFIER_ORDER = {"doi": 0, "pmid": 1, "pmcid": 2, "arxiv": 3, "isbn": 4, "issn": 5}


def _normalized_text(value: str) -> str:
    return _SPACE.sub(" ", unicodedata.normalize("NFKC", value).casefold()).strip()


def _identifier(value: Identifier) -> Identifier:
    namespace = _normalized_text(value.namespace)
    normalized = _normalized_text(value.value)
    if namespace == "doi":
        normalized = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", normalized)
    if namespace == "arxiv":
        normalized = re.sub(
            r"^(?:https?://(?:www\.)?arxiv\.org/(?:abs|pdf)/|arxiv:\s*)", "", normalized
        )
        normalized = re.sub(r"\.pdf$", "", normalized)
    return Identifier(namespace=namespace, value=normalized)


def _identifier_key(value: Identifier) -> tuple[str, str]:
    return value.namespace, value.value


def _identifier_keys(values: tuple[Identifier, ...]) -> set[tuple[str, str]]:
    return {_identifier_key(value) for value in values}


def _deduplicate_identifiers(values: tuple[Identifier, ...]) -> tuple[Identifier, ...]:
    normalized = {_identifier_key(value): value for value in (_identifier(item) for item in values)}
    return tuple(sorted(normalized.values(), key=lambda value: (value.namespace, value.value)))


def _normalize_observation(observation: BibliographicObservation) -> BibliographicObservation:
    return observation.model_copy(
        update={"identifiers": _deduplicate_identifiers(observation.identifiers)}
    )


def _metadata_signature(value: InitialMetadata) -> tuple[str, tuple[str, ...], int, str] | None:
    if value.title is None or not value.authors or value.year is None or value.item_type is None:
        return None
    return (
        _normalized_text(value.title),
        tuple(_normalized_text(author) for author in value.authors),
        value.year,
        _normalized_text(value.item_type),
    )


def _conflicts(left: InitialMetadata, right: InitialMetadata) -> tuple[str, ...]:
    reasons: list[str] = []
    title_conflict = bool(
        left.title and right.title and _normalized_text(left.title) != _normalized_text(right.title)
    )
    author_conflict = bool(
        left.authors
        and right.authors
        and tuple(map(_normalized_text, left.authors))
        != tuple(map(_normalized_text, right.authors))
    )
    if title_conflict and author_conflict:
        reasons.append("title-author-conflict")
    if left.year is not None and right.year is not None and left.year != right.year:
        reasons.append("year-conflict")
    if (
        left.item_type
        and right.item_type
        and _normalized_text(left.item_type) != _normalized_text(right.item_type)
    ):
        reasons.append("type-conflict")
    return tuple(reasons)


def _identifier_conflicts(
    left: Iterable[Identifier], right: Iterable[Identifier]
) -> tuple[str, ...]:
    left_map = {item.namespace: item.value for item in left}
    right_map = {item.namespace: item.value for item in right}
    return tuple(
        f"{namespace}-conflict"
        for namespace in sorted(left_map.keys() & right_map.keys())
        if left_map[namespace] != right_map[namespace]
    )


def _anchor(identifiers: tuple[Identifier, ...], metadata: InitialMetadata) -> str:
    if identifiers:
        selected = min(
            identifiers,
            key=lambda item: (
                _IDENTIFIER_ORDER.get(item.namespace, 99),
                item.namespace,
                item.value,
            ),
        )
        return f"identifier:{selected.namespace}:{selected.value}"
    signature = _metadata_signature(metadata)
    if signature is not None:
        return f"metadata:{signature!r}"
    return f"metadata:{hashlib.sha256(metadata_json(metadata).encode('ascii')).hexdigest()}"


def _record_key(record: IdentityRecord) -> tuple[int, str]:
    if not record.identifiers:
        return 100, str(record.work_version_id)
    selected = min(
        record.identifiers,
        key=lambda item: (_IDENTIFIER_ORDER.get(item.namespace, 99), item.namespace, item.value),
    )
    return _IDENTIFIER_ORDER.get(selected.namespace, 99), str(record.work_version_id)


def _matches(
    record: IdentityRecord, identifiers: tuple[Identifier, ...], metadata: InitialMetadata
) -> bool:
    shared = _identifier_keys(record.identifiers) & _identifier_keys(identifiers)
    record_signature = (
        None if record.current_metadata is None else _metadata_signature(record.current_metadata)
    )
    incoming_signature = _metadata_signature(metadata)
    exact_metadata = (
        record_signature is not None
        and incoming_signature is not None
        and record_signature == incoming_signature
    )
    return bool(shared) or (not identifiers and not record.identifiers and exact_metadata)


def _fuzzy(left: InitialMetadata, right: InitialMetadata) -> bool:
    if not left.title or not right.title:
        return False
    left_words = set(_normalized_text(left.title).split())
    right_words = set(_normalized_text(right.title).split())
    return len(left_words & right_words) >= 2


def _observation_anchor(observations: tuple[BibliographicObservation, ...]) -> str:
    evidence = "|".join(
        sorted(str(prepare_observation(item).observation_id) for item in observations)
    )
    return f"observation:{hashlib.sha256(evidence.encode('ascii')).hexdigest()}"


__all__ = (
    "_IDENTIFIER_ORDER",
    "_ROLE_ORDER",
    "_anchor",
    "_conflicts",
    "_deduplicate_identifiers",
    "_fuzzy",
    "_identifier",
    "_identifier_conflicts",
    "_identifier_key",
    "_identifier_keys",
    "_matches",
    "_metadata_signature",
    "_normalize_observation",
    "_observation_anchor",
    "_record_key",
)
