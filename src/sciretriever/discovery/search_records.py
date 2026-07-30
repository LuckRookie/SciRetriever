"""Provider-record normalization and deterministic ordering."""

from __future__ import annotations

from hashlib import sha256
import json
import unicodedata

from sciretriever.core.contracts import CandidateMetadata, Identifier
from .models import CandidateObservation, ProviderRecord
from .normalize import clean_text, identifier_sort_key


def normalize_candidate_observation(
    record: ProviderRecord,
) -> CandidateObservation | None:
    identifiers: set[Identifier] = set()
    for namespace, value in record.raw_identifiers:
        try:
            identifiers.add(Identifier(namespace, value))
        except (TypeError, ValueError):
            continue
    metadata = CandidateMetadata(
        title=clean_text(record.title),
        abstract=clean_text(record.abstract),
        authors=_stable_text(record.authors),
        year=record.year,
        venue=clean_text(record.venue),
        keywords=_stable_text(record.keywords),
    )
    ordered = tuple(sorted(identifiers, key=identifier_sort_key))
    if metadata.title is None and not ordered:
        return None
    provider_record_id = clean_text(record.provider_record_id) or _synthetic_id(
        record.provider, ordered, metadata
    )
    return CandidateObservation(
        record.provider,
        record.rank,
        provider_record_id,
        ordered,
        metadata,
        clean_text(record.publisher),
        clean_text(record.publication_date),
        clean_text(record.open_access_status),
    )


def normalize_candidate_title(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    without_punctuation = "".join(
        " " if unicodedata.category(character)[0] in {"P", "S"} else character
        for character in normalized
    )
    return " ".join(without_punctuation.split())


def raw_record_key(record: ProviderRecord) -> tuple[object, ...]:
    return (
        record.provider.casefold(),
        record.provider,
        record.rank,
        record.raw_identifiers,
        record.title or "",
        record.abstract or "",
        record.authors,
        record.year or -1,
        record.venue or "",
        record.publisher or "",
        record.publication_date or "",
        record.keywords,
        record.open_access_status or "",
        record.provider_record_id or "",
    )


def _stable_text(values: tuple[str, ...]) -> tuple[str, ...]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        value = clean_text(raw)
        if value is not None and value.casefold() not in seen:
            seen.add(value.casefold())
            result.append(value)
    return tuple(result)


def _synthetic_id(
    provider: str, identifiers: tuple[Identifier, ...], metadata: CandidateMetadata
) -> str:
    if identifiers:
        identifier = min(identifiers, key=identifier_sort_key)
        return f"{identifier.namespace}:{identifier.value}"
    payload = json.dumps(
        (
            provider,
            metadata.title,
            metadata.abstract,
            metadata.authors,
            metadata.year,
            metadata.venue,
            metadata.keywords,
        ),
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode()
    return f"synthetic:sha256:{sha256(payload).hexdigest()}"


__all__ = (
    "normalize_candidate_observation",
    "normalize_candidate_title",
    "raw_record_key",
)
