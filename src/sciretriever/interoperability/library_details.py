from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from sciretriever.interoperability.library_views import ReferenceView
from sciretriever.interoperability.library_views import (
    AnalysisView, AssetView, CurrentFailure, ExtensionResultView, LightDocumentView,
    MetadataView, ObservationView, ReferenceSetView, TagSetView,
)
from sciretriever.kernel import CanonicalJsonValue, Identifier, Provenance
from sciretriever.kernel.enums import WorkVersionState


@dataclass(frozen=True, slots=True)
class CollectionCause:
    cause_id: str
    collection_run_id: str
    kind: str
    source: str | None
    condition: str | None
    seed_work_id: str | None


@dataclass(frozen=True, slots=True)
class CollectionPath:
    path_id: str
    collection_run_id: str
    direction: str | None
    depth: int
    work_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class WorkCollectionMembership:
    collection_id: str
    first_collection_run_id: str
    causes: tuple[CollectionCause, ...]
    paths: tuple[CollectionPath, ...]


@dataclass(frozen=True, slots=True)
class GraphEdge:
    kind: Literal["graph-edge"]
    source_work_id: str
    source_work_version_id: str
    target_work_id: str
    target_work_version_id: str | None
    relation: Literal["references", "cited-by"]
    reference: ReferenceView


@dataclass(frozen=True, slots=True)
class UnresolvedReferenceItem:
    kind: Literal["unresolved-reference"]
    source_work_id: str
    source_work_version_id: str
    reference: ReferenceView


@dataclass(frozen=True, slots=True)
class WorkVersionDetail:
    kind: Literal["work-version-detail"]
    work_id: str
    work_version_id: str
    identifiers: tuple[Identifier, ...]
    metadata: MetadataView
    assets: tuple[AssetView, ...]
    light_document: LightDocumentView | None
    analysis: AnalysisView | None
    references: ReferenceSetView
    tags: TagSetView
    state: WorkVersionState
    missing_step: str | None
    current_failure: CurrentFailure | None
    observations_included: bool
    observations: tuple[ObservationView, ...]
    extension_namespaces: tuple[str, ...]
    extensions: tuple[ExtensionResultView, ...]
    provenance: tuple[Provenance, ...]


@dataclass(frozen=True, slots=True)
class WorkDetail:
    kind: Literal["work-detail"]
    work_id: str
    preferred_work_version_id: str
    at_least_one_completed: bool
    versions: tuple[WorkVersionDetail, ...]
    collection_memberships: tuple[WorkCollectionMembership, ...]
    work_references: tuple[GraphEdge, ...]


@dataclass(frozen=True, slots=True)
class GraphPage:
    edges: tuple[GraphEdge, ...]
    unresolved: tuple[UnresolvedReferenceItem, ...]
    next_cursor: str | None


@dataclass(frozen=True, slots=True)
class CollectionMembershipPage:
    memberships: tuple[tuple[str, WorkCollectionMembership], ...]
    next_after_work_id: str | None


__all__ = (
    "CollectionCause", "CollectionMembershipPage", "CollectionPath", "GraphEdge", "GraphPage",
    "UnresolvedReferenceItem", "WorkCollectionMembership",
    "WorkDetail", "WorkVersionDetail",
)
