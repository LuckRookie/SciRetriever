"""Pure decisions for authoritative Literature references.

The reference boundary is deliberately narrower than a relationship graph.  A
``ProviderRelationObservation`` remains a provider-owned source fact until a
caller supplies two already accepted concrete ``Literature`` values.  Text
evidence is supplied through short-lived evidence wrappers so that the durable
``ReferenceSupport`` model contains only an exact locator.

This module does not allocate IDs, resolve provider keys, call Metadata or
Analysis, persist a lookup, access Storage, or mutate an existing object.  The
caller reads one consistent snapshot and publishes the returned decision in a
separate transaction.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Literal, TypeAlias, TypeVar

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sciretriever.model.analysis import LiteratureContent
from sciretriever.model.literature import (
    ContentReferenceTextSupport,
    Literature,
    MetadataReferenceTextSupport,
    MetaLiterature,
    ProviderRelationSupport,
    Reference,
    ReferenceSupport,
)
from sciretriever.model.metadata import (
    MetadataObservation,
    ProviderRelationObservation,
)
from sciretriever.model.primitives import (
    LiteratureId,
    ReferenceId,
    Sha256,
)


class _ReferenceDecisionModel(BaseModel):
    """Strict, immutable service-side contracts for reference decisions."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


class ProviderRelationEvidence(_ReferenceDecisionModel):
    """A resolved view of one provider relation for one decision.

    The provider observation itself intentionally contains no local IDs.  The
    two Literature values here are a transient service input describing how an
    already selected relation was resolved; they are never copied into
    ``ReferenceSupport``.
    """

    observation: ProviderRelationObservation
    source: Literature
    target: Literature


class MetadataReferenceEvidence(_ReferenceDecisionModel):
    """A source-owned metadata observation and one zero-based text index."""

    literature: Literature
    observation: MetadataObservation
    reference_index: int = Field(strict=True, ge=0)


class ContentReferenceEvidence(_ReferenceDecisionModel):
    """The current content value and one zero-based reference text index."""

    literature: Literature
    content: LiteratureContent
    reference_index: int = Field(strict=True, ge=0)


ReferenceSupportEvidence: TypeAlias = (
    ProviderRelationEvidence | MetadataReferenceEvidence | ContentReferenceEvidence
)


ReferenceAcceptanceKind: TypeAlias = Literal["created", "matched", "rejected"]


class ReferenceAcceptanceDecision(_ReferenceDecisionModel):
    """One complete relation/support decision or a fail-closed rejection.

    For an accepted decision, ``supports`` is the complete current support set
    for this one source-to-target edge after locator de-duplication.  It is not
    a second persistent graph or a copy of the source evidence.
    """

    decision: ReferenceAcceptanceKind
    reference: Reference | None = None
    supports: tuple[ReferenceSupport, ...] = ()
    changed: bool = False
    reason: str | None = None

    @field_validator("supports", mode="before")
    @classmethod
    def normalize_supports(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="supports")

    @model_validator(mode="after")
    def validate_combination(self) -> "ReferenceAcceptanceDecision":
        if self.decision == "rejected":
            if self.reference is not None or self.supports or self.changed:
                raise ValueError("rejected reference decision cannot carry accepted facts")
            if self.reason is None:
                raise ValueError("rejected reference decision requires a reason")
            return self
        if self.reference is None or not self.supports:
            raise ValueError("accepted reference decision requires a reference and support")
        if self.reason is not None:
            raise ValueError("accepted reference decision cannot carry a reason")
        return self


ReferenceCleanupKind: TypeAlias = Literal["cleaned", "unchanged", "rejected"]


class ReferenceCleanupDecision(_ReferenceDecisionModel):
    """Pure result of replacing one current LiteratureContent hash.

    The caller deletes the returned old-content support locators and the
    references that would consequently have no support, in the same logical
    update as the new current content.  Unaffected graph facts are not copied
    into this command.
    """

    decision: ReferenceCleanupKind
    source_literature_id: LiteratureId
    old_content_sha256: Sha256
    removed_supports: tuple[ReferenceSupport, ...] = ()
    deleted_reference_ids: tuple[ReferenceId, ...] = ()
    reason: str | None = None

    @field_validator(
        "removed_supports",
        "deleted_reference_ids",
        mode="before",
    )
    @classmethod
    def normalize_collections(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="cleanup collection")

    @model_validator(mode="after")
    def validate_combination(self) -> "ReferenceCleanupDecision":
        if self.decision == "rejected":
            if self.removed_supports or self.deleted_reference_ids:
                raise ValueError("rejected cleanup cannot carry replacement facts")
            if self.reason is None:
                raise ValueError("rejected cleanup requires a reason")
            return self
        if self.reason is not None:
            raise ValueError("accepted cleanup cannot carry a reason")
        if self.decision == "unchanged" and (self.removed_supports or self.deleted_reference_ids):
            raise ValueError("unchanged cleanup cannot report removals")
        return self


_EvidenceT = TypeVar("_EvidenceT")


def decide_reference(  # noqa: C901
    source: Literature | MetaLiterature | None,
    target: Literature | MetaLiterature | None,
    accepted_literatures: Iterable[Literature],
    *,
    provider_relations: Iterable[ProviderRelationEvidence] = (),
    metadata_references: Iterable[MetadataReferenceEvidence] = (),
    content_references: Iterable[ContentReferenceEvidence] = (),
    target_candidates: Iterable[Literature] = (),
    reference_id: ReferenceId | None = None,
    existing_references: Iterable[Reference] = (),
    existing_supports: Iterable[ReferenceSupport] = (),
) -> ReferenceAcceptanceDecision:
    """Decide whether one authoritative directed reference can be published.

    ``source`` is always the citing Literature and ``target`` the cited
    Literature.  Both must be concrete values present in the caller's
    ``accepted_literatures`` snapshot.  A missing target can only be resolved
    from exactly one explicit candidate; zero candidates and multiple
    candidates fail closed without creating a placeholder.

    Evidence wrappers are temporary.  The accepted result contains only the
    three-ID ``Reference`` and locator-only ``ReferenceSupport`` values.  An
    existing exact edge is reused, and all support locators are merged by
    their natural source value.  A reverse edge is a separate exact edge.
    """

    accepted = _materialize(accepted_literatures, Literature, "accepted_literatures")
    candidates = _materialize(target_candidates, Literature, "target_candidates")
    existing_edges = _materialize(existing_references, Reference, "existing_references")
    existing_locator_values = _materialize(
        existing_supports,
        ReferenceSupport,
        "existing_supports",
    )

    source_result = _concrete_endpoint(source, endpoint="source")
    if source_result[0] is None:
        return _rejected(source_result[1] or "source-not-accepted")
    source_literature = source_result[0]
    assert source_literature is not None
    source_membership = _accepted_membership(source_literature, accepted, endpoint="source")
    if source_membership is not None:
        return _rejected(source_membership)

    target_result = _resolve_target(target, candidates)
    if target_result[0] is None:
        return _rejected(target_result[1] or "target-not-accepted")
    target_literature = target_result[0]
    assert target_literature is not None
    target_membership = _accepted_membership(target_literature, accepted, endpoint="target")
    if target_membership is not None:
        return _rejected(target_membership)

    if source_literature.literature_id == target_literature.literature_id:
        return _rejected("self-reference")

    edge_matches = tuple(
        reference
        for reference in existing_edges
        if (
            reference.source_literature_id == source_literature.literature_id
            and reference.target_literature_id == target_literature.literature_id
        )
    )
    if len(edge_matches) > 1:
        return _rejected("duplicate-reference")
    existing_edge = edge_matches[0] if edge_matches else None
    selected_reference_id = (
        existing_edge.reference_id if existing_edge is not None else reference_id
    )

    evidence = (
        tuple(_materialize(provider_relations, ProviderRelationEvidence, "provider_relations"))
        + tuple(_materialize(metadata_references, MetadataReferenceEvidence, "metadata_references"))
        + tuple(_materialize(content_references, ContentReferenceEvidence, "content_references"))
    )
    if evidence and selected_reference_id is None:
        return _rejected("reference-id-required")

    new_supports: tuple[ReferenceSupport, ...] = ()
    if evidence:
        assert selected_reference_id is not None
        generated: list[ReferenceSupport] = []
        for item in evidence:
            support, reason = _support_for_evidence(
                item,
                reference_id=selected_reference_id,
                source=source_literature,
                target=target_literature,
            )
            if support is None:
                return _rejected(reason or "invalid-support")
            generated.append(support)
        new_supports = _dedupe_supports(tuple(generated))

    if existing_edge is not None:
        existing_for_edge = tuple(
            support
            for support in existing_locator_values
            if support.reference_id == existing_edge.reference_id
        )
    else:
        existing_for_edge = ()
    merged = _dedupe_supports(existing_for_edge + new_supports)
    if not merged:
        return _rejected("support-missing")

    reference = existing_edge
    if reference is None:
        if reference_id is None:
            return _rejected("reference-id-required")
        reference = Reference(
            reference_id=reference_id,
            source_literature_id=source_literature.literature_id,
            target_literature_id=target_literature.literature_id,
        )
    changed = reference is not existing_edge or merged != existing_for_edge
    return ReferenceAcceptanceDecision(
        decision="matched" if existing_edge is not None else "created",
        reference=reference,
        supports=merged,
        changed=changed,
    )


def decide_content_replacement_cleanup(
    source_literature_id: LiteratureId,
    old_content_sha256: Sha256,
    references: Iterable[Reference],
    supports: Iterable[ReferenceSupport],
) -> ReferenceCleanupDecision:
    """Remove old-content locators and references left without support.

    This is the only content-replacement rule in this module.  It does not
    inspect files or decide whether a new content result is admissible.  It
    leaves provider and metadata support untouched and removes every
    ``ContentReferenceTextSupport`` pointing at the replaced hash.  The caller
    should publish the returned values atomically with the new content.
    """

    if not isinstance(source_literature_id, LiteratureId):
        raise TypeError("source_literature_id must be LiteratureId")
    if not isinstance(old_content_sha256, Sha256):
        raise TypeError("old_content_sha256 must be Sha256")
    current_references = _materialize(references, Reference, "references")
    supplied_supports = _materialize(supports, ReferenceSupport, "supports")
    current_supports = _dedupe_supports(supplied_supports)
    if len(current_supports) != len(supplied_supports):
        return _cleanup_rejected(
            source_literature_id,
            old_content_sha256,
            "duplicate-support",
        )
    reference_ids = {reference.reference_id for reference in current_references}
    if any(support.reference_id not in reference_ids for support in current_supports):
        return _cleanup_rejected(
            source_literature_id,
            old_content_sha256,
            "support-reference-mismatch",
        )
    if len(reference_ids) != len(current_references):
        return _cleanup_rejected(
            source_literature_id,
            old_content_sha256,
            "duplicate-reference-id",
        )

    source_reference_ids = {
        reference.reference_id
        for reference in current_references
        if reference.source_literature_id == source_literature_id
    }

    removed: list[ReferenceSupport] = []
    remaining: list[ReferenceSupport] = []
    for support in current_supports:
        source = support.source
        if (
            isinstance(source, ContentReferenceTextSupport)
            and support.reference_id in source_reference_ids
            and source.literature_content_sha256 == old_content_sha256
        ):
            removed.append(support)
        else:
            remaining.append(support)

    remaining_supports = tuple(remaining)
    supported_ids = {support.reference_id for support in remaining_supports}
    deleted_ids = tuple(
        reference.reference_id
        for reference in current_references
        if reference.reference_id in source_reference_ids
        and reference.reference_id not in supported_ids
    )
    changed = bool(removed or deleted_ids)
    return ReferenceCleanupDecision(
        decision="cleaned" if changed else "unchanged",
        source_literature_id=source_literature_id,
        old_content_sha256=old_content_sha256,
        removed_supports=tuple(removed),
        deleted_reference_ids=deleted_ids,
    )


def _support_for_evidence(
    evidence: ReferenceSupportEvidence,
    *,
    reference_id: ReferenceId,
    source: Literature,
    target: Literature,
) -> tuple[ReferenceSupport | None, str | None]:
    if isinstance(evidence, ProviderRelationEvidence):
        if (
            evidence.source.literature_id != source.literature_id
            or evidence.target.literature_id != target.literature_id
        ):
            return None, "provider-relation-direction-mismatch"
        return (
            ReferenceSupport(
                reference_id=reference_id,
                source=ProviderRelationSupport(
                    kind="provider_relation",
                    observation_id=evidence.observation.observation_id,
                ),
            ),
            None,
        )

    if isinstance(evidence, MetadataReferenceEvidence):
        if evidence.literature.literature_id != source.literature_id:
            return None, "metadata-support-source-mismatch"
        if evidence.reference_index >= len(evidence.observation.reference_texts):
            return None, "metadata-reference-index-out-of-range"
        return (
            ReferenceSupport(
                reference_id=reference_id,
                source=MetadataReferenceTextSupport(
                    kind="metadata_reference_text",
                    metadata_observation_id=evidence.observation.observation_id,
                    reference_index=evidence.reference_index,
                ),
            ),
            None,
        )

    if isinstance(evidence, ContentReferenceEvidence):
        if evidence.literature.literature_id != source.literature_id:
            return None, "content-support-source-mismatch"
        if evidence.reference_index >= len(evidence.content.references):
            return None, "content-reference-index-out-of-range"
        return (
            ReferenceSupport(
                reference_id=reference_id,
                source=ContentReferenceTextSupport(
                    kind="content_reference_text",
                    literature_content_sha256=evidence.content.literature_content_sha256,
                    reference_index=evidence.reference_index,
                ),
            ),
            None,
        )

    return None, "unsupported-support-evidence"


def _resolve_target(
    target: Literature | MetaLiterature | None,
    candidates: tuple[Literature, ...],
) -> tuple[Literature | None, str | None]:
    if target is not None:
        resolved = _concrete_endpoint(target, endpoint="target")
        return resolved
    unique: list[Literature] = []
    seen_ids: set[LiteratureId] = set()
    for candidate in candidates:
        if candidate.literature_id not in seen_ids:
            seen_ids.add(candidate.literature_id)
            unique.append(candidate)
    if len(unique) != 1:
        return None, "ambiguous-target" if len(unique) > 1 else "target-not-accepted"
    return unique[0], None


def _concrete_endpoint(
    endpoint_value: Literature | MetaLiterature | None,
    *,
    endpoint: Literal["source", "target"],
) -> tuple[Literature | None, str | None]:
    if isinstance(endpoint_value, MetaLiterature):
        return None, "meta-literature-endpoint"
    if not isinstance(endpoint_value, Literature):
        return None, f"{endpoint}-not-accepted"
    return endpoint_value, None


def _accepted_membership(
    literature: Literature,
    accepted: tuple[Literature, ...],
    *,
    endpoint: Literal["source", "target"],
) -> str | None:
    matches = tuple(
        candidate for candidate in accepted if candidate.literature_id == literature.literature_id
    )
    if not matches:
        return f"{endpoint}-not-accepted"
    if len(matches) > 1:
        return f"ambiguous-{endpoint}"
    return None


def _materialize(
    values: Iterable[_EvidenceT],
    expected: type[_EvidenceT],
    name: str,
) -> tuple[_EvidenceT, ...]:
    if isinstance(values, (str, bytes)):
        raise TypeError(f"{name} must contain {expected.__name__} values")
    try:
        result = tuple(values)
    except TypeError as error:
        raise TypeError(f"{name} must be an iterable of {expected.__name__} values") from error
    if any(not isinstance(value, expected) for value in result):
        raise TypeError(f"{name} must contain {expected.__name__} values")
    return result


def _as_tuple(value: object, *, field_name: str) -> tuple[object, ...]:
    if isinstance(value, tuple):
        return value
    if isinstance(value, list):
        return tuple(value)
    raise TypeError(f"{field_name} must be a list or tuple")


def _support_key(support: ReferenceSupport) -> tuple[ReferenceId, str, object]:
    source = support.source
    if isinstance(source, ProviderRelationSupport):
        return (support.reference_id, source.kind, source.observation_id)
    if isinstance(source, MetadataReferenceTextSupport):
        return (
            support.reference_id,
            source.kind,
            (source.metadata_observation_id, source.reference_index),
        )
    return (
        support.reference_id,
        source.kind,
        (source.literature_content_sha256, source.reference_index),
    )


def _dedupe_supports(supports: tuple[ReferenceSupport, ...]) -> tuple[ReferenceSupport, ...]:
    seen: set[tuple[ReferenceId, str, object]] = set()
    result: list[ReferenceSupport] = []
    for support in supports:
        key = _support_key(support)
        if key not in seen:
            seen.add(key)
            result.append(support)
    return tuple(result)


def _rejected(reason: str) -> ReferenceAcceptanceDecision:
    return ReferenceAcceptanceDecision(decision="rejected", reason=reason)


def _cleanup_rejected(
    source_literature_id: LiteratureId,
    old_content_sha256: Sha256,
    reason: str,
) -> ReferenceCleanupDecision:
    return ReferenceCleanupDecision(
        decision="rejected",
        source_literature_id=source_literature_id,
        old_content_sha256=old_content_sha256,
        reason=reason,
    )


__all__ = (
    "ContentReferenceEvidence",
    "MetadataReferenceEvidence",
    "ProviderRelationEvidence",
    "ReferenceAcceptanceDecision",
    "ReferenceAcceptanceKind",
    "ReferenceCleanupDecision",
    "ReferenceCleanupKind",
    "ReferenceSupportEvidence",
    "decide_content_replacement_cleanup",
    "decide_reference",
)
