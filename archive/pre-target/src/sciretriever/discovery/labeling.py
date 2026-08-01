"""Deterministic offline labeling with read-only catalog reuse."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping, Protocol, runtime_checkable
import unicodedata

from sciretriever.catalog.repository import ReadOnlyCatalogView, canonical_json
from sciretriever.core.contracts import CandidateMetadata, Identifier
from sciretriever.core.hashing import sha256_bytes
from sciretriever.discovery.models import MergedCandidate


def _required_text(value: str, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    normalized = " ".join(value.split())
    if not normalized:
        raise ValueError(f"{field_name} must not be blank")
    return normalized


def _match_text(value: str | None) -> str:
    return " ".join(unicodedata.normalize("NFKC", value or "").casefold().split())


def _stable_labels(labels: tuple[str, ...]) -> tuple[str, ...]:
    if not isinstance(labels, tuple):
        raise TypeError("labels must be a tuple")
    preferred: dict[str, str] = {}
    for label in labels:
        display = _required_text(label, "label")
        key = display.casefold()
        current = preferred.get(key)
        if current is None or display < current:
            preferred[key] = display
    return tuple(preferred[key] for key in sorted(preferred))


@dataclass(frozen=True, slots=True)
class LabelInput:
    title: str | None
    abstract: str | None

    def __post_init__(self) -> None:
        for field_name, value in (("title", self.title), ("abstract", self.abstract)):
            if value is not None and not isinstance(value, str):
                raise TypeError(f"{field_name} must be a string or None")


@dataclass(frozen=True, slots=True)
class LabelResult:
    labels: tuple[str, ...]
    needs_review: bool = False
    review_reason: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "labels", _stable_labels(self.labels))
        if not isinstance(self.needs_review, bool):
            raise TypeError("needs_review must be a boolean")
        if self.review_reason is not None:
            reason = _required_text(self.review_reason, "review_reason")
            object.__setattr__(self, "review_reason", reason)
            if not self.needs_review:
                raise ValueError("review_reason requires needs_review")


@runtime_checkable
class Labeler(Protocol):
    taxonomy: str
    taxonomy_version: str

    def label(self, label_input: LabelInput) -> LabelResult:
        ...


class KeywordRuleLabeler:
    """Apply normalized literal keyword rules without external services."""

    def __init__(
        self,
        taxonomy: str,
        taxonomy_version: str,
        rules: Mapping[str, Iterable[str]],
    ) -> None:
        self.taxonomy = _required_text(taxonomy, "taxonomy")
        self.taxonomy_version = _required_text(taxonomy_version, "taxonomy_version")
        if not isinstance(rules, Mapping):
            raise TypeError("rules must be a mapping")

        label_spellings: dict[str, set[str]] = {}
        normalized_rules: dict[str, set[str]] = {}
        for label, terms in rules.items():
            normalized_label = _required_text(label, "rule label")
            label_key = normalized_label.casefold()
            label_spellings.setdefault(label_key, set()).add(normalized_label)
            if isinstance(terms, (str, bytes)):
                raise TypeError("rule terms must be an iterable of strings")
            normalized_terms = normalized_rules.setdefault(label_key, set())
            try:
                iterator = iter(terms)
            except TypeError as error:
                raise TypeError("rule terms must be an iterable of strings") from error
            for term in iterator:
                required_term = _required_text(term, "rule term")
                normalized_terms.add(_match_text(required_term))

        self._rules = tuple(
            (min(label_spellings[key]), tuple(sorted(normalized_rules[key])))
            for key in sorted(normalized_rules)
        )

    def label(self, label_input: LabelInput) -> LabelResult:
        if not isinstance(label_input, LabelInput):
            raise TypeError("label_input must be LabelInput")
        text = " ".join(
            part for part in (_match_text(label_input.title), _match_text(label_input.abstract)) if part
        )
        labels = tuple(
            label for label, terms in self._rules if any(term in text for term in terms)
        )
        return LabelResult(labels)


@dataclass(frozen=True, slots=True)
class LabeledCandidate:
    identifiers: tuple[Identifier, ...]
    metadata: CandidateMetadata
    providers: tuple[str, ...]
    source_ranks: tuple[tuple[str, int], ...]
    labels: tuple[str, ...]
    needs_review: bool
    review_reasons: tuple[str, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "labels", _stable_labels(self.labels))

    @property
    def review_reason(self) -> str | None:
        return None if not self.review_reasons else "; ".join(self.review_reasons)


@dataclass(frozen=True, slots=True)
class CatalogLabelDecision:
    candidate: MergedCandidate
    taxonomy: str
    taxonomy_version: str
    cached_labels: tuple[str, ...] | None
    review_reasons: tuple[str, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.candidate, MergedCandidate):
            raise TypeError("candidate must be MergedCandidate")
        object.__setattr__(self, "taxonomy", _required_text(self.taxonomy, "taxonomy"))
        object.__setattr__(
            self,
            "taxonomy_version",
            _required_text(self.taxonomy_version, "taxonomy_version"),
        )
        if self.cached_labels is not None:
            object.__setattr__(self, "cached_labels", _stable_labels(self.cached_labels))
        if not isinstance(self.review_reasons, tuple) or not all(
            isinstance(reason, str) and reason for reason in self.review_reasons
        ):
            raise TypeError("review_reasons must be a tuple of non-blank strings")
        object.__setattr__(self, "review_reasons", tuple(sorted(set(self.review_reasons))))


def label_input_sha256(metadata: CandidateMetadata) -> str:
    """Hash the exact compact canonical JSON of title and abstract only."""
    if not isinstance(metadata, CandidateMetadata):
        raise TypeError("metadata must be CandidateMetadata")
    payload = canonical_json({"abstract": metadata.abstract, "title": metadata.title})
    return sha256_bytes(payload.encode("utf-8"))


def compare_candidate_with_catalog(
    candidate: MergedCandidate,
    catalog: ReadOnlyCatalogView,
    labeler: Labeler,
) -> CatalogLabelDecision:
    """Resolve catalog identity and exact label reuse without invoking the labeler."""
    if not isinstance(candidate, MergedCandidate):
        raise TypeError("candidate must be MergedCandidate")
    if not isinstance(catalog, ReadOnlyCatalogView):
        raise TypeError("catalog must be ReadOnlyCatalogView")
    if not isinstance(labeler, Labeler):
        raise TypeError("labeler must satisfy Labeler")

    taxonomy = _required_text(labeler.taxonomy, "taxonomy")
    taxonomy_version = _required_text(labeler.taxonomy_version, "taxonomy_version")
    works = {
        work.id: work
        for identifier in candidate.identifiers
        if (work := catalog.lookup_work(identifier)) is not None
    }
    reasons = set(candidate.review_reasons)
    cached_labels: tuple[str, ...] | None = None

    if len(works) == 1:
        work_id = next(iter(works))
        preferred_work_version_id = works[work_id].preferred_work_version_id
        cached = () if preferred_work_version_id is None else catalog.get_reusable_metadata_labels(
            preferred_work_version_id,
            taxonomy,
            taxonomy_version,
            label_input_sha256(candidate.metadata),
        )
        if cached:
            cached_labels = _stable_labels(tuple(row.label for row in cached))
            review_states = {row.needs_review for row in cached}
            if True in review_states:
                reasons.add("catalog_cached_label_needs_review")
            if len(review_states) > 1:
                reasons.add("catalog_cached_label_review_conflict")
    elif len(works) > 1:
        reasons.add("catalog_identifier_conflict")

    return CatalogLabelDecision(
        candidate,
        taxonomy,
        taxonomy_version,
        cached_labels,
        tuple(sorted(reasons)),
    )


def apply_label_decision(
    decision: CatalogLabelDecision,
    labeler: Labeler,
) -> LabeledCandidate:
    """Apply a catalog decision, invoking the labeler only on an exact cache miss."""
    if not isinstance(decision, CatalogLabelDecision):
        raise TypeError("decision must be CatalogLabelDecision")
    if not isinstance(labeler, Labeler):
        raise TypeError("labeler must satisfy Labeler")
    taxonomy = _required_text(labeler.taxonomy, "taxonomy")
    taxonomy_version = _required_text(labeler.taxonomy_version, "taxonomy_version")
    if taxonomy != decision.taxonomy or taxonomy_version != decision.taxonomy_version:
        raise ValueError("labeler taxonomy and version must match catalog label decision")

    candidate = decision.candidate
    result = (
        LabelResult(decision.cached_labels)
        if decision.cached_labels is not None
        else labeler.label(LabelInput(candidate.metadata.title, candidate.metadata.abstract))
    )
    if not isinstance(result, LabelResult):
        raise TypeError("labeler.label must return LabelResult")

    reasons = set(decision.review_reasons)
    if result.needs_review:
        reasons.add(result.review_reason or "labeler_needs_review")
    ordered_reasons = tuple(sorted(reasons))
    labels = _stable_labels(result.labels)
    return LabeledCandidate(
        candidate.identifiers,
        candidate.metadata,
        candidate.providers,
        candidate.source_ranks,
        labels,
        bool(ordered_reasons),
        ordered_reasons,
    )


def label_candidate(
    candidate: MergedCandidate,
    catalog: ReadOnlyCatalogView,
    labeler: Labeler,
) -> LabeledCandidate:
    """Label one merged candidate, reusing only an exact read-only catalog match."""
    return apply_label_decision(
        compare_candidate_with_catalog(candidate, catalog, labeler),
        labeler,
    )


__all__ = (
    "CatalogLabelDecision",
    "KeywordRuleLabeler",
    "LabelInput",
    "LabelResult",
    "LabeledCandidate",
    "Labeler",
    "apply_label_decision",
    "compare_candidate_with_catalog",
    "label_candidate",
    "label_input_sha256",
)
