from __future__ import annotations

from typing import assert_never

from sciretriever.core.collection import CollectionRuleError
from sciretriever.model.collection import (
    CitationCollectionRequest,
    CitationRunInput,
    CollectionSeed,
    IdentifierSeed,
    MembershipPageRequest,
    SeedSelector,
    WorkSeed,
    WorkVersionSeed,
)
from sciretriever.model.literature import IdentityCandidateQuery
from sciretriever.model.primitives import WorkId

from .ports import CollectionRepository, LiteratureServicePort


def _resolve_selector(  # noqa: C901
    selector: SeedSelector,
    literature: LiteratureServicePort,
    repository: CollectionRepository,
) -> tuple[WorkId, ...]:
    match selector:
        case WorkSeed(work_id=work_id):
            if literature.get_work_facts(work_id) is None:
                raise CollectionRuleError.for_field("seed", "Work does not exist")
            return (work_id,)
        case WorkVersionSeed(work_version_id=version_id):
            facts = literature.get_version_facts(version_id)
            if facts is None:
                raise CollectionRuleError.for_field("seed", "WorkVersion is missing or orphaned")
            return (facts.work_id,)
        case IdentifierSeed(identifier=identifier):
            candidates = literature.find_identity_candidates(
                IdentityCandidateQuery(identifiers=(identifier,))
            )
            work_ids = tuple(sorted({str(item.work_id) for item in candidates.candidates}))
            if len(work_ids) != 1:
                raise CollectionRuleError.for_field(
                    "seed", "Identifier must resolve to exactly one Work"
                )
            return (WorkId(work_ids[0]),)
        case CollectionSeed(collection_id=collection_id):
            if repository.get_definition(collection_id) is None:
                raise CollectionRuleError.for_field("seed", "Collection does not exist")
            members: list[WorkId] = []
            after = None
            while True:
                page = repository.list_memberships(
                    MembershipPageRequest(
                        collection_id=collection_id,
                        after_work_id=after,
                        limit=1000,
                    )
                )
                members.extend(item.work_id for item in page.members)
                after = page.next_after_work_id
                if after is None:
                    break
            if not members:
                raise CollectionRuleError.for_field("seed", "Collection has no members")
            return tuple(members)
        case unreachable:
            assert_never(unreachable)


def resolve_citation_input(
    request: CitationCollectionRequest,
    literature: LiteratureServicePort,
    repository: CollectionRepository,
) -> CitationRunInput:
    resolved: set[str] = set()
    for selector in request.seed_selectors:
        resolved.update(str(item) for item in _resolve_selector(selector, literature, repository))
    return CitationRunInput(
        original_selectors=request.seed_selectors,
        resolved_work_ids=tuple(WorkId(item) for item in sorted(resolved)),
        providers=request.providers,
        direction=request.direction,
        depth=request.depth,
        max_new=request.max_new,
    )


__all__ = ("resolve_citation_input",)
