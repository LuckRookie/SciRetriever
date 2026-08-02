from __future__ import annotations

from types import TracebackType
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
from sciretriever.model.primitives import (
    CollectionId,
    CollectionRunId,
    UtcTimestamp,
    WorkId,
    WorkVersionId,
)
from sciretriever.model.sources import (
    CitationDiscoveryRequest,
    MetadataDiscoveryRequest,
    ProviderCitationResult,
    ProviderDiscoveryResult,
)


class MetadataDiscoveryPort(Protocol):
    def search(self, request: MetadataDiscoveryRequest) -> ProviderDiscoveryResult: ...


class MetadataSourcePort(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def port(self) -> MetadataDiscoveryPort: ...


class CitationDiscoveryPort(Protocol):
    def expand(self, request: CitationDiscoveryRequest) -> ProviderCitationResult: ...


class CitationSourcePort(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def port(self) -> CitationDiscoveryPort: ...


class LiteratureServicePort(Protocol):
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


class CoreWriteGuard(Protocol):
    def __enter__(self) -> CoreWriteGuard: ...

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None: ...


class CoreWriteAcquirer(Protocol):
    def __call__(self) -> CoreWriteGuard: ...


class Clock(Protocol):
    def __call__(self) -> UtcTimestamp: ...


class CollectionUseCaseDependencies(Protocol):
    @property
    def repository(self) -> CollectionRepository: ...

    @property
    def literature(self) -> LiteratureServicePort: ...

    @property
    def publisher(self) -> CollectionAcceptancePublisher: ...

    @property
    def acquire_core_write(self) -> CoreWriteAcquirer: ...

    @property
    def metadata_sources(self) -> tuple[MetadataSourcePort, ...]: ...

    @property
    def citation_sources(self) -> tuple[CitationSourcePort, ...]: ...

    @property
    def clock(self) -> Clock: ...


__all__ = (
    "CitationDiscoveryPort",
    "CitationSourcePort",
    "Clock",
    "CollectionAcceptancePublisher",
    "CollectionRepository",
    "CollectionUseCaseDependencies",
    "CoreWriteAcquirer",
    "CoreWriteGuard",
    "LiteratureServicePort",
    "MetadataDiscoveryPort",
    "MetadataSourcePort",
)
