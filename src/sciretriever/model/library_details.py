from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

from sciretriever.model.collection import CollectionCauseKind
from sciretriever.model.documents import ReferenceView
from sciretriever.model.execution import CurrentFailure
from sciretriever.model.library_views import (
    AnalysisView,
    AssetView,
    ExtensionResultView,
    LightDocumentView,
    MetadataView,
    ObservationView,
    ReferenceSetView,
    TagSetView,
)
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import (
    CitationDirection,
    CollectionCauseId,
    CollectionId,
    CollectionPathId,
    CollectionRunId,
    MissingStep,
    WorkId,
    WorkVersionId,
    WorkVersionState,
)
from sciretriever.model.sources import Provenance


class _LibraryDetailModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class CollectionCause(_LibraryDetailModel):
    cause_id: CollectionCauseId
    collection_run_id: CollectionRunId
    kind: CollectionCauseKind
    source: str | None
    condition: str | None
    seed_work_id: WorkId | None


class CollectionPath(_LibraryDetailModel):
    path_id: CollectionPathId
    collection_run_id: CollectionRunId
    direction: CitationDirection | None
    depth: int
    work_ids: tuple[WorkId, ...]


class WorkCollectionMembership(_LibraryDetailModel):
    collection_id: CollectionId
    first_collection_run_id: CollectionRunId
    causes: tuple[CollectionCause, ...]
    paths: tuple[CollectionPath, ...]


class GraphEdge(_LibraryDetailModel):
    kind: Literal["graph-edge"]
    source_work_id: WorkId
    source_work_version_id: WorkVersionId
    target_work_id: WorkId
    target_work_version_id: WorkVersionId | None
    relation: Literal["references", "cited-by"]
    reference: ReferenceView


class UnresolvedReferenceItem(_LibraryDetailModel):
    kind: Literal["unresolved-reference"]
    source_work_id: WorkId
    source_work_version_id: WorkVersionId
    reference: ReferenceView


class WorkVersionDetail(_LibraryDetailModel):
    kind: Literal["work-version-detail"]
    work_id: WorkId
    work_version_id: WorkVersionId
    identifiers: tuple[Identifier, ...]
    metadata: MetadataView
    assets: tuple[AssetView, ...]
    light_document: LightDocumentView | None
    analysis: AnalysisView | None
    references: ReferenceSetView
    tags: TagSetView
    state: WorkVersionState
    missing_step: MissingStep | None
    current_failure: CurrentFailure | None
    observations_included: bool
    observations: tuple[ObservationView, ...]
    extension_namespaces: tuple[str, ...]
    extensions: tuple[ExtensionResultView, ...]
    provenance: tuple[Provenance, ...]


class WorkDetail(_LibraryDetailModel):
    kind: Literal["work-detail"]
    work_id: WorkId
    preferred_work_version_id: WorkVersionId
    at_least_one_completed: bool
    versions: tuple[WorkVersionDetail, ...]
    collection_memberships: tuple[WorkCollectionMembership, ...]
    work_references: tuple[GraphEdge, ...]


class GraphPage(_LibraryDetailModel):
    edges: tuple[GraphEdge, ...]
    unresolved: tuple[UnresolvedReferenceItem, ...]
    next_cursor: str | None


class CollectionMembershipPage(_LibraryDetailModel):
    memberships: tuple[tuple[WorkId, WorkCollectionMembership], ...]
    next_after_work_id: WorkId | None


__all__ = (
    "CollectionCause",
    "CollectionMembershipPage",
    "CollectionPath",
    "GraphEdge",
    "GraphPage",
    "UnresolvedReferenceItem",
    "WorkCollectionMembership",
    "WorkDetail",
    "WorkVersionDetail",
)
