"""Read-only manifest projection over shared metadata retrieval."""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import overload

from sciretriever.catalog.repository import ReadOnlyCatalogView
from sciretriever.core.contracts import DownloadManifestEntry, Provenance, SearchSpec
from sciretriever.core.ids import validate_uuid
from sciretriever.core.timestamps import parse_rfc3339
from sciretriever.discovery.candidate_retrieval import CandidatePreparer
from sciretriever.discovery.labeling import (
    Labeler,
    apply_label_decision,
    compare_candidate_with_catalog,
)
from sciretriever.discovery.models import (
    CandidateRetrievalRequest,
    MergedCandidate,
    ProviderFailure,
    RetrievedCandidate,
)
from sciretriever.discovery.provider_collection import (
    ProviderCollectionRequest,
    ProviderCollector,
)
from sciretriever.discovery.providers.base import DiscoveryProvider
from sciretriever.errors import SearchError


@dataclass(frozen=True, slots=True)
class DiscoveryOutput(Sequence[DownloadManifestEntry]):
    entries: tuple[DownloadManifestEntry, ...]
    failures: tuple[ProviderFailure, ...]

    def __len__(self) -> int:
        return len(self.entries)

    def __iter__(self) -> Iterator[DownloadManifestEntry]:
        return iter(self.entries)

    @overload
    def __getitem__(self, index: int) -> DownloadManifestEntry: ...

    @overload
    def __getitem__(self, index: slice) -> tuple[DownloadManifestEntry, ...]: ...

    def __getitem__(
        self, index: int | slice
    ) -> DownloadManifestEntry | tuple[DownloadManifestEntry, ...]:
        return self.entries[index]


def _manifest_candidate(candidate: RetrievedCandidate) -> MergedCandidate:
    review_reasons = tuple(sorted(
        set(candidate.quality_reasons).union(candidate.identity_ambiguity_reasons)
    ))
    providers = tuple(sorted(candidate.providers, key=lambda value: (value.casefold(), value)))
    return MergedCandidate(
        candidate.identifiers,
        candidate.metadata,
        providers,
        candidate.source_ranks,
        bool(review_reasons),
        review_reasons,
    )


def discover(
    spec: SearchSpec,
    *,
    providers: Mapping[str, DiscoveryProvider],
    catalog: ReadOnlyCatalogView,
    labeler: Labeler,
    intake_run_id: str,
    retrieved_at: str,
    provider_timeout_seconds: float = 30.0,
) -> DiscoveryOutput:
    """Run the complete discovery pipeline without mutating catalog or filesystem state."""
    if not isinstance(spec, SearchSpec):
        raise TypeError("spec must be SearchSpec")
    if not isinstance(catalog, ReadOnlyCatalogView):
        raise TypeError("catalog must be ReadOnlyCatalogView")
    if not isinstance(labeler, Labeler):
        raise TypeError("labeler must satisfy Labeler")
    validate_uuid(intake_run_id, "intake_run_id")
    parse_rfc3339(retrieved_at)
    if not isinstance(providers, Mapping):
        raise TypeError("providers must be a mapping")
    precedence = tuple(dict.fromkeys(spec.sources))
    effective_spec = SearchSpec(spec.query, precedence, spec.limit, spec.filters)
    collected = ProviderCollector(providers).collect(ProviderCollectionRequest(
        effective_spec.query,
        precedence,
        effective_spec.limit,
        provider_timeout_seconds,
        8,
        precedence,
        effective_spec.filters,
    ))
    failures = tuple(
        ProviderFailure(item.provider, item.category, item.message)
        for item in collected.failures
    )
    if collected.all_failed:
        detail = "; ".join(
            f"{failure.provider}:{failure.category}" for failure in failures
        )
        raise SearchError(f"all metadata search providers failed: {detail}")
    retrieval = CandidatePreparer().prepare(
        CandidateRetrievalRequest(
            effective_spec,
            precedence,
            provider_timeout_seconds,
            8,
        ),
        collected.records,
        failures,
    )
    selected = tuple(_manifest_candidate(candidate) for candidate in retrieval.candidates)
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
    return DiscoveryOutput(tuple(entries), retrieval.failures)


__all__ = ("DiscoveryOutput", "discover")
