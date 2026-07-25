"""Normalized provider records and catalog observation projection."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json

from sciretriever.catalog.library import MetadataIngestionObservation
from sciretriever.core.contracts import CandidateMetadata, Identifier
from .models import ProviderRecord
from .normalize import clean_text, identifier_sort_key, normalize_record


@dataclass(frozen=True, slots=True)
class ObservedMetadataRecord:
    record: ProviderRecord
    identifiers: tuple[Identifier, ...]
    metadata: CandidateMetadata
    provider_record_id: str


def normalize_provider_record(record: ProviderRecord) -> ObservedMetadataRecord | None:
    candidate = normalize_record(record)
    if candidate is None:
        return None
    return ObservedMetadataRecord(
        record=record,
        identifiers=candidate.identifiers,
        metadata=candidate.metadata,
        provider_record_id=_provider_record_id(
            record, candidate.identifiers, candidate.metadata
        ),
    )


def exact_doi_record(
    record: ObservedMetadataRecord, doi: str
) -> ObservedMetadataRecord | None:
    if not any(
        identifier.namespace == "doi" and identifier.value == doi
        for identifier in record.identifiers
    ):
        return None
    identifiers = tuple(
        identifier
        for identifier in record.identifiers
        if identifier.namespace != "doi" or identifier.value == doi
    )
    return ObservedMetadataRecord(
        record=record.record,
        identifiers=identifiers,
        metadata=record.metadata,
        provider_record_id=record.provider_record_id,
    )


def metadata_observation(record: ObservedMetadataRecord) -> MetadataIngestionObservation:
    fields: list[tuple[str, object]] = []
    values = {
        "title": record.metadata.title,
        "abstract": record.metadata.abstract,
        "authors": record.metadata.authors,
        "year": record.metadata.year,
        "venue": record.metadata.venue,
        "publisher": clean_text(record.record.publisher),
        "publication_date": clean_text(record.record.publication_date),
        "open_access_status": clean_text(record.record.open_access_status),
        "keywords": record.metadata.keywords,
    }
    fields.extend(
        (name, value) for name, value in values.items()
        if value is not None and value != ()
    )
    fields.extend(
        (identifier.namespace, identifier.value) for identifier in record.identifiers
    )
    return MetadataIngestionObservation(
        provider=record.record.provider,
        provider_record_id=record.provider_record_id,
        fields=tuple(sorted(fields, key=lambda pair: (pair[0], str(pair[1])))),
        provenance=(
            ("provider", record.record.provider),
            ("provider_record_id", record.provider_record_id),
        ),
    )


def raw_record_key(record: ProviderRecord) -> tuple[object, ...]:
    return (
        record.provider.casefold(), record.provider, record.rank, record.raw_identifiers,
        record.title or "", record.abstract or "", record.authors, record.year or -1,
        record.venue or "", record.publisher or "", record.publication_date or "",
        record.keywords, record.open_access_status or "", record.provider_record_id or "",
    )


def _provider_record_id(
    record: ProviderRecord,
    identifiers: tuple[Identifier, ...],
    metadata: CandidateMetadata,
) -> str:
    explicit = clean_text(record.provider_record_id)
    if explicit is not None:
        return explicit
    if identifiers:
        identifier = min(identifiers, key=identifier_sort_key)
        return f"{identifier.namespace}:{identifier.value}"
    payload = {
        "provider": record.provider,
        "title": metadata.title,
        "abstract": metadata.abstract,
        "authors": metadata.authors,
        "year": metadata.year,
        "venue": metadata.venue,
        "publisher": clean_text(record.publisher),
        "publication_date": clean_text(record.publication_date),
        "open_access_status": clean_text(record.open_access_status),
        "keywords": metadata.keywords,
    }
    encoded = json.dumps(
        payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True
    ).encode()
    return f"synthetic:sha256:{sha256(encoded).hexdigest()}"


__all__ = (
    "ObservedMetadataRecord",
    "exact_doi_record",
    "metadata_observation",
    "normalize_provider_record",
    "raw_record_key",
)
