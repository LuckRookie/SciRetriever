"""Fixed-order orchestration for provider-neutral literature discovery."""

from __future__ import annotations

from collections.abc import Mapping
from sciretriever.catalog.repository import ReadOnlyCatalogView, canonical_json
from sciretriever.core.contracts import DownloadManifestEntry, Provenance, SearchSpec
from sciretriever.core.ids import validate_uuid
from sciretriever.core.timestamps import parse_rfc3339
from sciretriever.discovery.dedup import deduplicate_candidates
from sciretriever.discovery.labeling import (
    Labeler,
    apply_label_decision,
    compare_candidate_with_catalog,
)
from sciretriever.discovery.models import MergedCandidate, ProviderRecord
from sciretriever.discovery.normalize import identifier_sort_key, normalize_records
from sciretriever.discovery.providers.base import DiscoveryProvider


_BUILTIN_PROVIDER_ORDER = {"crossref": 0, "europe-pmc": 1, "arxiv": 2}


def _provider_key(name: str) -> tuple[int, str, str]:
    normalized = name.casefold()
    return (_BUILTIN_PROVIDER_ORDER.get(normalized, 3), normalized, name)


def _candidate_key(candidate: MergedCandidate) -> tuple[object, ...]:
    best_rank = min(rank for _, rank in candidate.source_ranks)
    provider = min(candidate.providers, key=_provider_key)
    primary_identifier = (
        identifier_sort_key(candidate.identifiers[0])
        if candidate.identifiers
        else (5, "", "")
    )
    title = candidate.metadata.title or ""
    return (
        best_rank,
        _provider_key(provider),
        primary_identifier,
        title.casefold(),
        title,
        canonical_json(candidate.metadata.to_dict()),
    )


def _requested_providers(
    spec: SearchSpec,
    providers: Mapping[str, DiscoveryProvider],
) -> tuple[DiscoveryProvider, ...]:
    if not isinstance(providers, Mapping):
        raise TypeError("providers must be a mapping")
    missing = set(spec.sources) - providers.keys()
    if missing:
        raise ValueError(f"missing discovery providers: {', '.join(sorted(missing))}")

    requested: list[tuple[str, DiscoveryProvider]] = []
    for source in set(spec.sources):
        provider = providers[source]
        if provider.name != source:
            raise ValueError(
                f"provider registered as {source!r} reports name {provider.name!r}"
            )
        requested.append((source, provider))
    return tuple(provider for _, provider in sorted(requested, key=lambda item: _provider_key(item[0])))


def discover(
    spec: SearchSpec,
    *,
    providers: Mapping[str, DiscoveryProvider],
    catalog: ReadOnlyCatalogView,
    labeler: Labeler,
    intake_run_id: str,
    retrieved_at: str,
) -> tuple[DownloadManifestEntry, ...]:
    """Run the complete discovery pipeline without mutating catalog or filesystem state."""
    if not isinstance(spec, SearchSpec):
        raise TypeError("spec must be SearchSpec")
    if not isinstance(catalog, ReadOnlyCatalogView):
        raise TypeError("catalog must be ReadOnlyCatalogView")
    if not isinstance(labeler, Labeler):
        raise TypeError("labeler must satisfy Labeler")
    validate_uuid(intake_run_id, "intake_run_id")
    parse_rfc3339(retrieved_at)
    selected_providers = _requested_providers(spec, providers)

    records: list[ProviderRecord] = []
    for provider in selected_providers:
        provider_records = tuple(provider.search(spec))
        if not all(isinstance(record, ProviderRecord) for record in provider_records):
            raise TypeError("provider search results must contain ProviderRecord values")
        mismatched = tuple(
            record.provider for record in provider_records if record.provider != provider.name
        )
        if mismatched:
            raise ValueError(
                f"provider {provider.name!r} returned a record for {mismatched[0]!r}"
            )
        records.extend(provider_records)

    candidates = normalize_records(tuple(records))
    merged = deduplicate_candidates(candidates)
    selected = tuple(sorted(merged, key=_candidate_key))[: spec.limit]
    decisions = tuple(
        compare_candidate_with_catalog(candidate, catalog, labeler)
        for candidate in selected
    )
    labeled_candidates = tuple(
        apply_label_decision(decision, labeler) for decision in decisions
    )

    entries: list[DownloadManifestEntry] = []
    for labeled in labeled_candidates:
        entries.append(
            DownloadManifestEntry(
                identifiers=labeled.identifiers,
                metadata=labeled.metadata,
                labels=labeled.labels,
                missing_abstract=labeled.metadata.abstract is None,
                needs_review=labeled.needs_review,
                review_reason=labeled.review_reason,
                provenance=Provenance(
                    providers=labeled.providers,
                    retrieved_at=retrieved_at,
                    intake_run_id=intake_run_id,
                ),
            )
        )
    return tuple(entries)


__all__ = ("discover",)
