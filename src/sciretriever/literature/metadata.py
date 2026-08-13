"""Pure acceptance and projection decisions for literature metadata.

``MetadataObservation`` is the durable source fact, while
``LiteratureMetadata`` is only the current projection consumed by the rest of
the Literature feature.  This module deliberately sits between those Model
objects and persistence: it validates the small Literature-owned admission
rules, delegates concrete identity matching to :mod:`identity`, and returns
closed Pydantic decisions.  It never creates IDs, writes observations, opens a
file, calls a provider, or keeps a revision history.

The caller supplies the current observations and the current metadata revision
from one consistent snapshot.  The caller is responsible for persisting the
returned observation and projection atomically.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sciretriever.literature.identity import (
    STABLE_IDENTIFIER_NAMESPACES,
    IdentityDecision,
    normalize_identity_text,
    resolve_literature_identity,
)
from sciretriever.model.literature import Affiliation, Author, Literature
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.primitives import Sha256, SourceKind, sha256_digest

ProjectionOutcome: TypeAlias = Literal["projected", "unchanged", "preserved", "rejected"]
AcceptanceOutcome: TypeAlias = Literal["created", "matched", "rejected"]

_USER_OBSERVATION_HASH_TAG = "sciretriever-user-observation-semantic-v1"


class _MetadataDecisionModel(BaseModel):
    """Frozen, closed, strict decision values owned by Literature."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


class MetadataProjectionDecision(_MetadataDecisionModel):
    """Result of projecting observations into the current metadata value.

    ``metadata_revision`` is a caller-visible concurrency token, not a
    history record.  A successful changed projection advances it exactly once;
    an unchanged or content-aligned projection keeps it unchanged.
    """

    outcome: ProjectionOutcome
    metadata: LiteratureMetadata | None = None
    metadata_revision: int = Field(strict=True, ge=1)
    changed: bool = False
    projection_preserved: bool = False
    observations_projection_changed: bool = False
    reason: str | None = None

    @model_validator(mode="after")
    def validate_combination(self) -> "MetadataProjectionDecision":
        if self.outcome == "rejected":
            if self.metadata is not None:
                raise ValueError("rejected projection cannot carry metadata")
            if self.changed or self.projection_preserved or self.observations_projection_changed:
                raise ValueError("rejected projection cannot claim a changed or preserved value")
            if self.reason is None:
                raise ValueError("rejected projection requires a reason")
            return self

        if self.metadata is None:
            raise ValueError("accepted projection requires metadata")
        if self.outcome == "preserved":
            if not self.projection_preserved or self.changed:
                raise ValueError("preserved projection must retain the current value")
        elif self.projection_preserved:
            raise ValueError("only a preserved projection may carry its marker")
        return self


class MetadataObservationAcceptanceDecision(_MetadataDecisionModel):
    """Result of admitting one immutable metadata observation.

    ``observations`` is the resulting in-memory source sequence for the
    caller's transaction.  It is not a persistence command and contains no
    Literature relation fields because the Model intentionally owns no such
    relation.
    """

    outcome: AcceptanceOutcome
    observation: MetadataObservation | None = None
    literature: Literature | None = None
    observations: tuple[MetadataObservation, ...] = ()
    identity: IdentityDecision | None = None
    projection: MetadataProjectionDecision | None = None
    reason: str | None = None
    deduplicated: bool = False

    @field_validator("observations", mode="before")
    @classmethod
    def normalize_observations(cls, value: object) -> tuple[object, ...]:
        if isinstance(value, tuple):
            return value
        if isinstance(value, list):
            return tuple(value)
        raise TypeError("observations must be a list or tuple")

    @model_validator(mode="after")
    def validate_combination(self) -> "MetadataObservationAcceptanceDecision":
        if self.outcome == "rejected":
            if (
                self.observation is not None
                or self.literature is not None
                or self.observations
                or self.deduplicated
                or self.projection is not None
            ):
                raise ValueError("rejected acceptance cannot carry an observation")
            if self.reason is None:
                raise ValueError("rejected acceptance requires a reason")
            return self

        if self.observation is None or not self.observations:
            raise ValueError("accepted observation requires source facts")
        if self.outcome == "created" and self.deduplicated:
            raise ValueError("created observation cannot be deduplicated")
        if self.outcome == "created" and self.reason == "duplicate-observation":
            raise ValueError("created observation cannot have duplicate reason")
        if self.projection is None:
            raise ValueError("accepted observation requires a projection decision")
        if self.projection.outcome == "rejected":
            raise ValueError("accepted observation cannot carry a rejected projection")
        if self.deduplicated and self.projection.observations_projection_changed:
            raise ValueError("deduplicated observation cannot change the source projection")
        return self


def project_metadata(  # noqa: C901
    observations: Iterable[MetadataObservation],
    *,
    provider_precedence: Iterable[str] = (),
    current_metadata: LiteratureMetadata | None = None,
    metadata_revision: int = 1,
    expected_metadata_revision: int | None = None,
    content_ready: bool = False,
) -> MetadataProjectionDecision:
    """Project observations into one deterministic current metadata value.

    User observations are always ordered before providers.  Within the user
    and provider groups, the caller's order is retained; provider groups are
    arranged by ``provider_precedence`` and unlisted providers are appended in
    their original order.  A non-empty value from a higher-priority source is
    never silently overwritten by a lower-priority source.

    Provider ``declared_keywords`` never enter the projection.  Keywords
    explicitly supplied by a bibliographic-import observation use the same
    import-first rule as the other metadata fields; provider observations do
    not use ``LiteratureMetadata.keywords`` as a second declared-keyword path.
    """

    source_observations = _materialize_observations(observations, field_name="observations")
    precedence = _materialize_precedence(provider_precedence)
    _validate_revision(metadata_revision, field_name="metadata_revision")
    if expected_metadata_revision is not None:
        _validate_revision(expected_metadata_revision, field_name="expected_metadata_revision")
        if expected_metadata_revision != metadata_revision:
            return _rejected_projection(metadata_revision, "metadata-revision-stale")
    if current_metadata is not None and not isinstance(current_metadata, LiteratureMetadata):
        raise TypeError("current_metadata must be a LiteratureMetadata")
    if type(content_ready) is not bool:
        raise TypeError("content_ready must be a bool")
    if content_ready and current_metadata is None:
        raise ValueError("content-ready projection requires current_metadata")

    ordered = _order_observations(source_observations, precedence)
    candidate, conflict_reason = _build_projection(ordered)
    if conflict_reason is not None:
        return _rejected_projection(metadata_revision, conflict_reason)

    if current_metadata is not None:
        current_conflict = _metadata_pair_conflict(current_metadata, candidate)
        if current_conflict is not None:
            return _rejected_projection(metadata_revision, current_conflict)

    if current_metadata is None:
        return MetadataProjectionDecision(
            outcome="projected",
            metadata=candidate,
            metadata_revision=metadata_revision,
            changed=True,
        )

    changed = candidate != current_metadata
    if content_ready:
        return MetadataProjectionDecision(
            outcome="preserved",
            metadata=current_metadata,
            metadata_revision=metadata_revision,
            changed=False,
            projection_preserved=True,
            reason="content-ready-current-metadata-preserved",
        )
    if not changed:
        return MetadataProjectionDecision(
            outcome="unchanged",
            metadata=current_metadata,
            metadata_revision=metadata_revision,
            changed=False,
        )
    return MetadataProjectionDecision(
        outcome="projected",
        metadata=candidate,
        metadata_revision=metadata_revision + 1,
        changed=True,
    )


def accept_observation(  # noqa: C901
    observation: MetadataObservation,
    *,
    existing_literature: Iterable[Literature] = (),
    existing_observations: Iterable[MetadataObservation] = (),
    provider_precedence: Iterable[str] = (),
    current_metadata: LiteratureMetadata | None = None,
    metadata_revision: int = 1,
    expected_metadata_revision: int | None = None,
    content_ready: bool = False,
) -> MetadataObservationAcceptanceDecision:
    """Return the pure decision for one provider or user observation.

    The minimum admission rule is deliberately narrow: a source must provide
    a non-empty title or a DOI.  Identity matching and stable-ID conflict
    handling are delegated to L1.  An exact observation-ID replay is returned
    as ``matched`` with ``deduplicated=True``.  User imports additionally
    deduplicate by complete normalized import semantics, while every new
    provider observation ID remains an independent durable source fact.  A new
    source observation is retained even when it does not change the current
    projection.
    """

    if not isinstance(observation, MetadataObservation):
        raise TypeError("observation must be a MetadataObservation")
    existing = _materialize_observations(existing_observations, field_name="existing_observations")
    literatures = _materialize_literatures(existing_literature)

    minimum_reason = _minimum_admission_reason(observation.metadata)
    if minimum_reason is not None:
        return _rejected_acceptance(minimum_reason)

    identity = resolve_literature_identity(observation.metadata, literatures)
    if identity.decision == "identity-conflict":
        return _rejected_acceptance(identity.reason or "identity-conflict", identity=identity)

    same_id_matches = tuple(
        item for item in existing if item.observation_id == observation.observation_id
    )
    if len(same_id_matches) > 1:
        return _rejected_acceptance("observation-replay-ambiguous", identity=identity)
    same_id = same_id_matches[0] if same_id_matches else None
    if same_id is not None and not _same_observation_semantics(same_id, observation):
        return _rejected_acceptance("observation-id-conflict", identity=identity)
    if observation.provenance.source_kind is SourceKind.USER:
        semantic_matches = tuple(
            item for item in existing if same_user_observation(item, observation)
        )
        if len(semantic_matches) > 1:
            return _rejected_acceptance("observation-replay-ambiguous", identity=identity)
        duplicate = semantic_matches[0] if semantic_matches else None
    else:
        duplicate = same_id
    if duplicate is not None:
        merged_observations = existing
        outcome: AcceptanceOutcome = "matched"
        reason = "duplicate-observation"
        deduplicated = True
    else:
        merged_observations = (*existing, observation)
        outcome = "matched" if identity.decision == "matched" else "created"
        reason = identity.reason
        deduplicated = False

    precedence = _materialize_precedence(provider_precedence)
    projection = project_metadata(
        merged_observations,
        provider_precedence=precedence,
        current_metadata=current_metadata,
        metadata_revision=metadata_revision,
        expected_metadata_revision=expected_metadata_revision,
        content_ready=content_ready,
    )
    if projection.outcome == "rejected":
        return _rejected_acceptance(projection.reason or "projection-rejected", identity=identity)
    if not deduplicated:
        existing_projection = project_metadata(
            existing,
            provider_precedence=precedence,
        )
        merged_projection = project_metadata(
            merged_observations,
            provider_precedence=precedence,
        )
        if existing_projection.outcome == "rejected":
            return _rejected_acceptance(
                existing_projection.reason or "existing-projection-rejected",
                identity=identity,
            )
        if merged_projection.outcome == "rejected":
            return _rejected_acceptance(
                merged_projection.reason or "projection-rejected",
                identity=identity,
            )
        projection = projection.model_copy(
            update={
                "observations_projection_changed": (
                    existing_projection.metadata != merged_projection.metadata
                )
            }
        )

    return MetadataObservationAcceptanceDecision(
        outcome=outcome,
        observation=duplicate or observation,
        literature=identity.literature,
        observations=merged_observations,
        identity=identity,
        projection=projection,
        reason=reason,
        deduplicated=deduplicated,
    )


def user_observation_semantic_sha256(observation: MetadataObservation) -> Sha256:
    """Hash all semantic user-observation fields with a domain tag.

    ``observation_id``, ``provenance_id`` and ``observed_at`` are ingestion
    identities/timestamps rather than the imported bibliographic value.  They
    are intentionally excluded so a replay with a newly allocated source ID
    can still be looked up by the Storage adapter.  Every other user-visible
    observation field is represented in the tagged canonical JSON payload.
    Storage may use the digest as an equality index, but Literature must still
    compare the complete observation object after a hit to remain safe against
    a hash collision.
    """

    if not isinstance(observation, MetadataObservation):
        raise TypeError("observation must be a MetadataObservation")
    if observation.provenance.source_kind is not SourceKind.USER:
        raise ValueError("semantic user-observation hash requires a user observation")

    tagged = {
        "schema": _USER_OBSERVATION_HASH_TAG,
        "value": _observation_semantic_value(observation),
    }
    encoded = json.dumps(
        tagged,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return sha256_digest(encoded)


def same_user_observation(left: MetadataObservation, right: MetadataObservation) -> bool:
    """Compare complete user observation semantics after an index hit."""

    if not isinstance(left, MetadataObservation) or not isinstance(right, MetadataObservation):
        raise TypeError("observations must be MetadataObservation values")
    if (
        left.provenance.source_kind is not SourceKind.USER
        or right.provenance.source_kind is not SourceKind.USER
    ):
        return False
    return _observation_semantic_value(left) == _observation_semantic_value(right)


def same_provider_observation(left: MetadataObservation, right: MetadataObservation) -> bool:
    """Compare complete provider semantics while ignoring ingestion IDs and time."""

    if not isinstance(left, MetadataObservation) or not isinstance(right, MetadataObservation):
        raise TypeError("observations must be MetadataObservation values")
    if (
        left.provenance.source_kind is not SourceKind.METADATA_PROVIDER
        or right.provenance.source_kind is not SourceKind.METADATA_PROVIDER
    ):
        return False
    return _observation_semantic_value(left) == _observation_semantic_value(right)


def _observation_semantic_value(observation: MetadataObservation) -> dict[str, object]:
    """Return the one complete semantic value shared by hash and equality.

    Source object IDs and the ingestion timestamp are intentionally absent;
    every retained bibliographic/source field is present.  Keeping this one
    representation behind both public operations prevents the Storage lookup
    hash and Literature's collision check from drifting apart.
    """

    provenance = observation.provenance
    return {
        "asset_hints": [item.model_dump(mode="json") for item in observation.asset_hints],
        "cited_by_count": observation.cited_by_count,
        "declared_keywords": list(observation.declared_keywords),
        "metadata": observation.metadata.model_dump(mode="json"),
        "provenance": {
            "source_kind": provenance.source_kind.value,
            "source_name": provenance.source_name,
            "source_record_id": provenance.source_record_id,
            "input_sha256": str(provenance.input_sha256)
            if provenance.input_sha256 is not None
            else None,
            "parameters_sha256": str(provenance.parameters_sha256)
            if provenance.parameters_sha256 is not None
            else None,
        },
        "reference_count": observation.reference_count,
        "reference_texts": list(observation.reference_texts),
        "version_links": [item.model_dump(mode="json") for item in observation.version_links],
        "version_role": observation.version_role.value
        if observation.version_role is not None
        else None,
    }


def _same_observation_semantics(
    left: MetadataObservation,
    right: MetadataObservation,
) -> bool:
    kind = right.provenance.source_kind
    if left.provenance.source_kind is not kind:
        return False
    if kind is SourceKind.USER:
        return same_user_observation(left, right)
    if kind is SourceKind.METADATA_PROVIDER:
        return same_provider_observation(left, right)
    return False


def _build_projection(  # noqa: C901
    observations: tuple[MetadataObservation, ...],
) -> tuple[LiteratureMetadata, str | None]:
    values: dict[str, object] = {}
    scalar_fields = (
        "title",
        "abstract",
        "publication_date",
        "publication_year",
        "document_type",
        "language",
        "venue",
        "publisher",
        "volume",
        "issue",
        "pages",
    )
    for field_name in scalar_fields:
        for observation in observations:
            value = getattr(observation.metadata, field_name)
            if value is not None:
                values[field_name] = value
                break

    identifiers: list[object] = []
    seen_identifiers: set[object] = set()
    stable_by_namespace: dict[str, set[str]] = {}
    for observation in observations:
        for identifier in observation.metadata.identifiers:
            key = (identifier.namespace, identifier.value)
            if identifier.namespace in STABLE_IDENTIFIER_NAMESPACES:
                namespace_values = stable_by_namespace.setdefault(identifier.namespace, set())
                namespace_values.add(identifier.value)
                if len(namespace_values) > 1:
                    return LiteratureMetadata(), "stable-identifier-conflict"
            if key not in seen_identifiers:
                identifiers.append(identifier)
                seen_identifiers.add(key)

    authors: tuple[Author, ...] = ()
    for observation in observations:
        source_authors = observation.metadata.authors
        if not source_authors:
            continue
        if not authors:
            authors = source_authors
        else:
            authors = _supplement_authors(authors, source_authors)

    values["authors"] = authors
    values["identifiers"] = tuple(identifiers)
    values["keywords"] = next(
        (
            observation.metadata.keywords
            for observation in observations
            if observation.provenance.source_kind is SourceKind.USER
            and observation.metadata.keywords
        ),
        (),
    )
    return LiteratureMetadata.model_validate(values), None


def _supplement_authors(
    base: tuple[Author, ...],
    source: tuple[Author, ...],
) -> tuple[Author, ...]:
    if not _author_lists_align(base, source):
        return base
    return tuple(_supplement_author(left, right) for left, right in zip(base, source))


def _author_lists_align(base: tuple[Author, ...], source: tuple[Author, ...]) -> bool:
    if len(base) == 1 and len(source) == 1:
        base_orcid = base[0].orcid
        source_orcid = source[0].orcid
        if base_orcid is not None and base_orcid == source_orcid:
            return True
    if len(base) != len(source):
        return False
    return all(
        left.kind == right.kind
        and normalize_identity_text(left.display_name)
        == normalize_identity_text(right.display_name)
        for left, right in zip(base, source)
    )


def _supplement_author(base: Author, source: Author) -> Author:
    affiliations = _merge_affiliations(base.affiliations, source.affiliations)
    return Author(
        kind=base.kind,
        display_name=base.display_name,
        given_name=base.given_name or source.given_name,
        family_name=base.family_name or source.family_name,
        orcid=base.orcid or source.orcid,
        affiliations=affiliations,
    )


def _merge_affiliations(
    base: tuple[Affiliation, ...],
    source: tuple[Affiliation, ...],
) -> tuple[Affiliation, ...]:
    merged = list(base)
    for candidate in source:
        if any(_same_affiliation(existing, candidate) for existing in merged):
            continue
        merged.append(candidate)
    return tuple(merged)


def _same_affiliation(left: Affiliation, right: Affiliation) -> bool:
    if left.ror is not None and right.ror is not None and left.ror == right.ror:
        return True
    return normalize_identity_text(left.name) == normalize_identity_text(right.name)


def _metadata_pair_conflict(
    current: LiteratureMetadata,
    candidate: LiteratureMetadata,
) -> str | None:
    current_values = _stable_values_by_namespace(current)
    candidate_values = _stable_values_by_namespace(candidate)
    for namespace in STABLE_IDENTIFIER_NAMESPACES:
        left = current_values.get(namespace, set())
        right = candidate_values.get(namespace, set())
        if left and right and left != right:
            return "stable-identifier-conflict"
    return None


def _stable_values_by_namespace(metadata: LiteratureMetadata) -> dict[str, set[str]]:
    values: dict[str, set[str]] = {}
    for identifier in metadata.identifiers:
        if identifier.namespace in STABLE_IDENTIFIER_NAMESPACES:
            values.setdefault(identifier.namespace, set()).add(identifier.value)
    return values


def _minimum_admission_reason(metadata: LiteratureMetadata) -> str | None:
    if metadata.title is not None:
        return None
    if any(identifier.namespace == "doi" for identifier in metadata.identifiers):
        return None
    return "missing-title-or-doi"


def _order_observations(
    observations: tuple[MetadataObservation, ...],
    precedence: tuple[str, ...],
) -> tuple[MetadataObservation, ...]:
    users = tuple(item for item in observations if item.provenance.source_kind is SourceKind.USER)
    providers = tuple(
        item for item in observations if item.provenance.source_kind is SourceKind.METADATA_PROVIDER
    )
    ordered_providers: list[MetadataObservation] = []
    used_names: set[str] = set()
    for source_name in precedence:
        if source_name in used_names:
            continue
        used_names.add(source_name)
        ordered_providers.extend(
            item for item in providers if item.provenance.source_name == source_name
        )
    ordered_providers.extend(
        item for item in providers if item.provenance.source_name not in used_names
    )
    return (*users, *ordered_providers)


def _materialize_observations(
    values: Iterable[MetadataObservation],
    *,
    field_name: str,
) -> tuple[MetadataObservation, ...]:
    if isinstance(values, (str, bytes)):
        raise TypeError(f"{field_name} must contain MetadataObservation values")
    try:
        result = tuple(values)
    except TypeError as error:
        raise TypeError(
            f"{field_name} must be an iterable of MetadataObservation values"
        ) from error
    if any(not isinstance(value, MetadataObservation) for value in result):
        raise TypeError(f"{field_name} must contain MetadataObservation values")
    return result


def _materialize_literatures(values: Iterable[Literature]) -> tuple[Literature, ...]:
    if isinstance(values, (str, bytes)):
        raise TypeError("existing_literature must contain Literature values")
    try:
        result = tuple(values)
    except TypeError as error:
        raise TypeError("existing_literature must be an iterable of Literature values") from error
    if any(not isinstance(value, Literature) for value in result):
        raise TypeError("existing_literature must contain Literature values")
    return result


def _materialize_precedence(
    values: Iterable[str],
) -> tuple[str, ...]:
    if isinstance(values, (str, bytes)):
        raise TypeError("provider_precedence must be an iterable of provider names")
    try:
        items = tuple(values)
    except TypeError as error:
        raise TypeError("provider_precedence must be an iterable") from error
    names: list[str] = []
    for item in items:
        if type(item) is not str:
            raise TypeError("provider_precedence entries must be strings")
        name = item
        if not name.strip():
            raise ValueError("provider_precedence names must be nonblank")
        if name in names:
            raise ValueError("provider_precedence names must be unique")
        names.append(name)
    return tuple(names)


def _validate_revision(value: object, *, field_name: str) -> None:
    if type(value) is not int or value < 1:
        raise ValueError(f"{field_name} must be a positive integer")


def _rejected_projection(
    metadata_revision: int,
    reason: str,
) -> MetadataProjectionDecision:
    return MetadataProjectionDecision(
        outcome="rejected",
        metadata_revision=metadata_revision,
        reason=reason,
    )


def _rejected_acceptance(
    reason: str,
    *,
    identity: IdentityDecision | None = None,
) -> MetadataObservationAcceptanceDecision:
    return MetadataObservationAcceptanceDecision(
        outcome="rejected",
        identity=identity,
        reason=reason,
    )


__all__ = (
    "AcceptanceOutcome",
    "MetadataObservationAcceptanceDecision",
    "MetadataProjectionDecision",
    "ProjectionOutcome",
    "accept_observation",
    "project_metadata",
    "same_provider_observation",
    "same_user_observation",
    "user_observation_semantic_sha256",
)
