from __future__ import annotations

from uuid import UUID, uuid5

from typing_extensions import assert_never

from sciretriever.core.collection import CollectionRuleError
from sciretriever.model.canonical_json import CanonicalJsonObject, canonical_json_bytes
from sciretriever.model.collection import (
    CollectionCauseFact,
    CollectionMembershipFact,
    CollectionPathFact,
    ExistingCollectionAcceptance,
)
from sciretriever.model.primitives import (
    CitationDirection,
    CollectionCauseId,
    CollectionCauseKind,
    CollectionId,
    CollectionPathId,
    CollectionRunId,
    MembershipId,
    WorkId,
)
from sciretriever.model.sources import CitationObservation

_NAMESPACE = UUID("f4fc7f3d-633b-4cc3-8ae7-e32c83cc932d")


def membership(
    collection_id: CollectionId,
    work_id: WorkId,
    run_id: CollectionRunId,
) -> CollectionMembershipFact:
    identifier = MembershipId(str(uuid5(_NAMESPACE, f"membership:{collection_id}:{work_id}")))
    return CollectionMembershipFact(
        membership_id=identifier,
        collection_id=collection_id,
        work_id=work_id,
        first_run_id=run_id,
    )


def seed_acceptance(
    collection_id: CollectionId,
    run_id: CollectionRunId,
    seed: WorkId,
) -> ExistingCollectionAcceptance:
    value = membership(collection_id, seed, run_id)
    cause = CollectionCauseFact(
        cause_id=CollectionCauseId(str(uuid5(_NAMESPACE, f"seed:{run_id}:{seed}"))),
        membership_id=value.membership_id,
        run_id=run_id,
        kind=CollectionCauseKind.SEED,
        evidence=canonical_json_bytes(CanonicalJsonObject((("work_id", str(seed)),))).decode(
            "ascii"
        ),
        seed_work_id=seed,
    )
    path = CollectionPathFact(
        path_id=CollectionPathId(str(uuid5(_NAMESPACE, f"seed-path:{run_id}:{seed}"))),
        membership_id=value.membership_id,
        run_id=run_id,
        direction=None,
        depth=0,
        work_ids=(seed,),
    )
    return ExistingCollectionAcceptance(membership=value, causes=(cause,), paths=(path,))


def citation_evidence(
    membership_value: CollectionMembershipFact,
    run_id: CollectionRunId,
    source: str,
    parent: WorkId,
    observation: CitationObservation,
    path: tuple[WorkId, ...],
) -> tuple[CollectionCauseFact, CollectionPathFact]:
    key = (
        f"{run_id}:{source}:{parent}:{observation.direction.value}:"
        f"{observation.target_identifier.namespace}:{observation.target_identifier.value}:"
        f"{':'.join(map(str, path))}"
    )
    match observation.direction:
        case CitationDirection.REFERENCES:
            kind = CollectionCauseKind.REFERENCE
        case CitationDirection.CITED_BY:
            kind = CollectionCauseKind.CITED_BY
        case CitationDirection.BOTH:
            raise CollectionRuleError.for_field(
                "citation response", "must contain a single citation direction"
            )
        case unreachable:
            assert_never(unreachable)
    cause = CollectionCauseFact(
        cause_id=CollectionCauseId(str(uuid5(_NAMESPACE, f"cause:{key}"))),
        membership_id=membership_value.membership_id,
        run_id=run_id,
        kind=kind,
        evidence=canonical_json_bytes(
            CanonicalJsonObject(
                (
                    ("identifier", observation.target_identifier.model_dump_json()),
                    ("provider", source),
                )
            )
        ).decode("ascii"),
        seed_work_id=path[0],
    )
    citation_path = CollectionPathFact(
        path_id=CollectionPathId(str(uuid5(_NAMESPACE, f"path:{key}"))),
        membership_id=membership_value.membership_id,
        run_id=run_id,
        direction=observation.direction,
        depth=len(path) - 1,
        work_ids=path,
    )
    return cause, citation_path


__all__ = ("citation_evidence", "membership", "seed_acceptance")
