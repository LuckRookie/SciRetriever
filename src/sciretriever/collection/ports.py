from __future__ import annotations

from typing import Protocol

from sciretriever.model.collection import (
    CausePage,
    CausePageRequest,
    CitationRunInput,
    CollectionAcceptance,
    CollectionDefinition,
    CollectionRunRecord,
    CreateCollectionDefinition,
    ExistingCollectionAcceptance,
    FinishCollectionRun,
    MembershipPage,
    MembershipPageRequest,
    PathPage,
    PathPageRequest,
    StartCollectionRun,
)
from sciretriever.model.literature import (
    BibliographicObservation,
    IdentityCandidateQuery,
    IdentityCandidateSet,
    PreparedBibliographyAcceptance,
    VersionFacts,
    WorkFacts,
)
from sciretriever.model.primitives import CollectionId, CollectionRunId, WorkId, WorkVersionId
from sciretriever.model.sources import (
    CitationDiscoveryRequest,
    CitationObservation,
    MetadataDiscoveryRequest,
    MetadataObservation,
    ProviderCitationResult,
    ProviderDiscoveryResult,
)


class MetadataDiscoveryPort(Protocol):
    def search(self, request: MetadataDiscoveryRequest) -> ProviderDiscoveryResult: ...


class CitationDiscoveryPort(Protocol):
    def expand(self, request: CitationDiscoveryRequest) -> ProviderCitationResult: ...


class BibliographyIngestionPort(Protocol):
    def prepare_discovery(
        self, observation: BibliographicObservation
    ) -> PreparedBibliographyAcceptance: ...
    def find_identity_candidates(self, query: IdentityCandidateQuery) -> IdentityCandidateSet: ...
    def get_work_facts(self, work_id: WorkId) -> WorkFacts | None: ...
    def get_version_facts(self, version_id: WorkVersionId) -> VersionFacts | None: ...


class CollectionAcceptancePublisher(Protocol):
    def publish(self, command: CollectionAcceptance) -> None: ...
    def publish_existing(self, command: ExistingCollectionAcceptance) -> None: ...


class CollectionRepository(Protocol):
    def create_definition(self, command: CreateCollectionDefinition) -> CollectionDefinition: ...
    def get_definition(self, collection_id: CollectionId) -> CollectionDefinition | None: ...
    def start_run(self, command: StartCollectionRun) -> CollectionRunRecord: ...
    def get_run(self, run_id: CollectionRunId) -> CollectionRunRecord | None: ...
    def finish_run(self, command: FinishCollectionRun) -> CollectionRunRecord: ...
    def list_memberships(self, request: MembershipPageRequest) -> MembershipPage: ...
    def list_causes(self, request: CausePageRequest) -> CausePage: ...
    def list_paths(self, request: PathPageRequest) -> PathPage: ...
    def get_citation_input(self, run_id: CollectionRunId) -> CitationRunInput | None: ...


__all__ = (
    "BibliographyIngestionPort",
    "CitationDiscoveryPort",
    "CitationDiscoveryRequest",
    "CitationObservation",
    "CollectionAcceptancePublisher",
    "CollectionRepository",
    "MetadataDiscoveryPort",
    "MetadataDiscoveryRequest",
    "MetadataObservation",
    "ProviderCitationResult",
    "ProviderDiscoveryResult",
)
