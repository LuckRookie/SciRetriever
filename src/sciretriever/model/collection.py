from __future__ import annotations

from typing import Annotated, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import (
    CitationDirection,
    CollectionId,
    CollectionRunId,
    CollectionRunStatus,
    Sha256,
    UtcTimestamp,
    WorkId,
    WorkVersionId,
)

NonBlankText = Annotated[str, StringConstraints(pattern=r".*\S.*")]
NonNegativeInt = Annotated[int, Field(ge=0)]
PositiveInt = Annotated[int, Field(ge=1)]


class _CollectionModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class ValidatedTopicConditionSet(_CollectionModel):
    canonical_json: str
    sha256: Sha256


class WorkSeed(_CollectionModel):
    work_id: WorkId


class WorkVersionSeed(_CollectionModel):
    work_version_id: WorkVersionId


class IdentifierSeed(_CollectionModel):
    identifier: Identifier


class CollectionSeed(_CollectionModel):
    collection_id: CollectionId


SeedSelector: TypeAlias = WorkSeed | WorkVersionSeed | IdentifierSeed | CollectionSeed


class CitationCollectionRequest(_CollectionModel):
    seed_selectors: tuple[SeedSelector, ...]
    providers: tuple[NonBlankText, ...]
    direction: CitationDirection
    depth: NonNegativeInt
    max_new: PositiveInt


class CitationRunInput(_CollectionModel):
    original_selectors: tuple[SeedSelector, ...]
    resolved_work_ids: tuple[WorkId, ...]
    providers: tuple[NonBlankText, ...]
    direction: CitationDirection
    depth: NonNegativeInt
    max_new: PositiveInt


class ValidatedCitationInput(_CollectionModel):
    canonical_json: str
    sha256: Sha256


class CollectionCounts(_CollectionModel):
    discovered: NonNegativeInt
    accepted: NonNegativeInt
    new_members: NonNegativeInt
    existing_members: NonNegativeInt
    missing: NonNegativeInt
    source_failures: NonNegativeInt


class CollectionSourceResult(_CollectionModel):
    ordinal: NonNegativeInt
    source: NonBlankText
    discovered: NonNegativeInt
    accepted: NonNegativeInt
    missing: NonNegativeInt
    failure_code: NonBlankText | None = None
    failure_reason: NonBlankText | None = None
    failure_action: NonBlankText | None = None
    retryable: bool | None = None


class CollectionDefinition(_CollectionModel):
    collection_id: CollectionId
    name: str
    description: str | None
    topic_conditions: ValidatedTopicConditionSet | None
    created_at: UtcTimestamp


class CreateCollectionDefinition(_CollectionModel):
    definition: CollectionDefinition


class StartCollectionRun(_CollectionModel):
    run_id: CollectionRunId
    collection_id: CollectionId
    mode: str
    topic_conditions: ValidatedTopicConditionSet | None
    citation_input: ValidatedCitationInput | None
    requested_advance_to: str


class FinishCollectionRun(_CollectionModel):
    run_id: CollectionRunId
    status: CollectionRunStatus
    stop_reason: NonBlankText | None
    counts: CollectionCounts
    source_results: tuple[CollectionSourceResult, ...]


class CollectionRunRecord(_CollectionModel):
    run_id: CollectionRunId
    collection_id: CollectionId
    mode: str
    requested_advance_to: str
    status: CollectionRunStatus
    stop_reason: str | None
    created_at: UtcTimestamp
    counts: CollectionCounts | None
    source_results: tuple[CollectionSourceResult, ...]


class MembershipPageRequest(_CollectionModel):
    collection_id: CollectionId
    after_work_id: WorkId | None
    limit: Annotated[int, Field(ge=1, le=1000)]


class CollectionMember(_CollectionModel):
    work_id: WorkId
    first_collection_run_id: CollectionRunId


class MembershipPage(_CollectionModel):
    members: tuple[CollectionMember, ...]
    next_after_work_id: WorkId | None


__all__ = (
    "CitationCollectionRequest",
    "CitationRunInput",
    "CollectionCounts",
    "CollectionDefinition",
    "CollectionMember",
    "CollectionRunRecord",
    "CollectionSeed",
    "CollectionSourceResult",
    "CreateCollectionDefinition",
    "FinishCollectionRun",
    "IdentifierSeed",
    "MembershipPage",
    "MembershipPageRequest",
    "SeedSelector",
    "StartCollectionRun",
    "ValidatedCitationInput",
    "ValidatedTopicConditionSet",
    "WorkSeed",
    "WorkVersionSeed",
)
