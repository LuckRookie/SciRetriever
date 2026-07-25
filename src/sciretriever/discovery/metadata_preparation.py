"""Prepare normalized metadata records for atomic catalog ingestion."""

from __future__ import annotations

from dataclasses import dataclass

from sciretriever.catalog.library import MetadataIngestionBatch, normalize_title
from sciretriever.core.contracts import Identifier
from .models import ProviderRecord
from .normalize import identifier_sort_key
from .search_matching import (
    ambiguities,
    canonical_metadata,
    merge_groups,
)
from .search_records import (
    ObservedMetadataRecord,
    exact_doi_record,
    metadata_observation,
    normalize_provider_record,
    raw_record_key,
)
from sciretriever.errors import SearchError


@dataclass(frozen=True, slots=True)
class PreparedMetadata:
    batch: MetadataIngestionBatch
    providers: tuple[str, ...]
    identifiers: tuple[Identifier, ...]


class MetadataRecordPreparer:
    """Normalize, group, and project provider records without catalog writes."""

    def prepare_search(
        self,
        records: tuple[ProviderRecord, ...],
        precedence: tuple[str, ...],
        limit: int,
    ) -> tuple[PreparedMetadata, ...]:
        normalized = self._normalize(records)
        ambiguous_titles, ambiguous_identifiers = ambiguities(normalized)
        groups = merge_groups(
            normalized,
            precedence,
            ambiguous_titles,
            ambiguous_identifiers,
        )[:limit]
        return tuple(
            self._prepare_group(
                group,
                precedence,
                ambiguous_titles,
                ambiguous_identifiers,
            )
            for group in groups
        )

    def prepare_exact(
        self,
        records: tuple[ProviderRecord, ...],
        doi: str,
        precedence: tuple[str, ...],
    ) -> PreparedMetadata | None:
        exact = tuple(
            exact_record
            for record in self._normalize(records)
            if (exact_record := exact_doi_record(record, doi)) is not None
        )
        if not exact or canonical_metadata(exact).title is None:
            return None
        order = {provider: index for index, provider in enumerate(precedence)}
        group = tuple(sorted(
            exact,
            key=lambda item: (
                order[item.record.provider],
                raw_record_key(item.record),
            ),
        ))
        return self._prepare_group(group, precedence, frozenset(), frozenset())

    @staticmethod
    def _normalize(
        records: tuple[ProviderRecord, ...]
    ) -> tuple[ObservedMetadataRecord, ...]:
        return tuple(
            normalized
            for record in records
            if (normalized := normalize_provider_record(record)) is not None
        )

    @staticmethod
    def _prepare_group(
        group: tuple[ObservedMetadataRecord, ...],
        precedence: tuple[str, ...],
        ambiguous_titles: frozenset[str],
        ambiguous_identifiers: frozenset[Identifier],
    ) -> PreparedMetadata:
        metadata = canonical_metadata(group)
        if metadata.title is None:
            raise SearchError("merged metadata result has no title")
        identifiers = tuple(sorted(
            {
                identifier
                for item in group
                for identifier in item.identifiers
                if identifier not in ambiguous_identifiers
            },
            key=identifier_sort_key,
        ))
        has_ambiguous_title = any(
            item.metadata.title is not None
            and normalize_title(item.metadata.title) in ambiguous_titles
            for item in group
        )
        has_ambiguous_identifier = any(
            identifier in ambiguous_identifiers
            for item in group
            for identifier in item.identifiers
        )
        return PreparedMetadata(
            MetadataIngestionBatch(
                metadata.title,
                identifiers,
                tuple(metadata_observation(item) for item in group),
                precedence,
                (
                    "conflicting DOI bridge evidence"
                    if has_ambiguous_title or has_ambiguous_identifier
                    else None
                ),
            ),
            tuple(dict.fromkeys(item.record.provider for item in group)),
            identifiers,
        )


__all__ = ("MetadataRecordPreparer", "PreparedMetadata")
