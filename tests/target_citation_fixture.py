from __future__ import annotations

import os
import unittest
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

from test_target_collection import FakeMetadataPort, observation

from sciretriever.bibliography.api import (
    IdentityCandidateQuery,
    IdentityCandidateSet,
    WorkFacts,
)
from sciretriever.collection.api import TopicConditions
from sciretriever.collection.bibliography_gateway import InitialBibliographyIngestion
from sciretriever.collection.service import (
    CitationSource,
    CollectionService,
    CollectionServiceDependencies,
    MetadataSource,
)
from sciretriever.literature_store.filesystem import LocalAdmissionBindingFactory
from sciretriever.literature_store.sqlite import (
    CollectionAcceptancePublisher,
    SqliteBibliographyRepository,
    SqliteCollectionRepository,
    create_or_open_catalog,
)
from sciretriever.model.literature import (
    BibliographicObservation,
    Identifier,
    PreparedBibliographyAcceptance,
    VersionFacts,
)
from sciretriever.model.primitives import (
    CitationDirection,
    WorkId,
    WorkVersionId,
    WorkVersionState,
)
from sciretriever.model.sources import (
    CitationDiscoveryRequest,
    CitationObservation,
    ProviderCitationResult,
    ProviderDiscoveryResult,
)


@dataclass(frozen=True, slots=True)
class FakeCitationPort:
    catalog: Path
    edges: dict[tuple[str, CitationDirection], tuple[Identifier, ...]]
    provider: str
    requests: list[CitationDiscoveryRequest]
    failing: frozenset[str] = frozenset()

    def expand(self, request: CitationDiscoveryRequest) -> ProviderCitationResult:
        self.requests.append(request)
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.rollback()
        if str(request.seed) in self.failing:
            raise OSError("provider branch failed")
        values = self.edges.get((str(request.seed), request.direction), ())
        return ProviderCitationResult(
            provider=self.provider,
            observations=tuple(
                CitationObservation(
                    provider=self.provider,
                    source_work_id=request.seed,
                    target_identifier=item,
                    direction=request.direction,
                )
                for item in values
            ),
            failure=None,
        )


@dataclass(frozen=True, slots=True)
class FixedCandidateBibliography:
    delegate: InitialBibliographyIngestion
    candidates: IdentityCandidateSet

    def prepare_discovery(
        self, observation: BibliographicObservation
    ) -> PreparedBibliographyAcceptance:
        return self.delegate.prepare_discovery(observation)

    def find_identity_candidates(self, query: IdentityCandidateQuery) -> IdentityCandidateSet:
        return self.candidates

    def get_work_facts(self, work_id: WorkId) -> WorkFacts | None:
        return self.delegate.get_work_facts(work_id)

    def get_version_facts(self, version_id: WorkVersionId) -> VersionFacts | None:
        return self.delegate.get_version_facts(version_id)


class CitationCollectionTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-task15-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)
        self.catalog = self.root / "catalog.sqlite"
        with create_or_open_catalog(self.catalog):
            pass
        self.collections = SqliteCollectionRepository(self.catalog)
        self.bibliography = InitialBibliographyIngestion(SqliteBibliographyRepository(self.catalog))
        self.bound = LocalAdmissionBindingFactory().bind_catalog(self.catalog)

    def service(self, citation_sources: tuple[CitationSource, ...] = ()) -> CollectionService:
        metadata = FakeMetadataPort(
            self.catalog,
            ProviderDiscoveryResult(provider="seed", observations=(), failure=None),
            [],
        )
        return CollectionService(
            CollectionServiceDependencies(
                self.collections,
                self.bibliography,
                CollectionAcceptancePublisher(self.catalog),
                lambda: self.bound.port.acquire_core_write(self.bound.identity),
                (MetadataSource("seed", metadata),),
                citation_sources,
            )
        )

    def add_work(self, doi: str):
        metadata = FakeMetadataPort(
            self.catalog,
            ProviderDiscoveryResult(
                provider="seed",
                observations=(observation("seed", doi, doi),),
                failure=None,
            ),
            [],
        )
        service = CollectionService(
            CollectionServiceDependencies(
                self.collections,
                self.bibliography,
                CollectionAcceptancePublisher(self.catalog),
                lambda: self.bound.port.acquire_core_write(self.bound.identity),
                (MetadataSource("seed", metadata),),
                (),
            )
        )
        definition = service.create(f"seed-{doi}", None, TopicConditions(doi))
        service.run_topic(definition.collection_id, WorkVersionState.UNREVIEWED)
        repository = SqliteBibliographyRepository(self.catalog)
        candidate = repository.find_identity_candidates(
            IdentityCandidateQuery((Identifier(namespace="doi", value=doi),)),
        ).candidates[0]
        record = next(
            item
            for item in repository.list_identity_records()
            if item.work_version_id == candidate.work_version_id
        )
        return definition, record


__all__ = (
    "CitationCollectionTestCase",
    "FakeCitationPort",
    "FixedCandidateBibliography",
)
