from __future__ import annotations

import os
import sqlite3
import unittest
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

from sciretriever.collection.api import CollectionAcceptanceConflict
from sciretriever.collection.service import (
    CollectionService,
    CollectionServiceDependencies,
    MetadataSource,
)
from sciretriever.collection.topic import validated_topic_conditions
from sciretriever.kernel import (
    BoundaryError,
    CanonicalJsonObject,
    parse_canonical_json,
)
from sciretriever.literature_store.filesystem import LocalAdmissionBindingFactory
from sciretriever.literature_store.sqlite import (
    CollectionAcceptancePublisher,
    SqliteCollectionRepository,
    SqliteLiteratureRepository,
    create_or_open_catalog,
    open_read_only_snapshot,
)
from sciretriever.model.collection import CausePageRequest, CollectionAcceptance, TopicConditions
from sciretriever.model.execution import Action, FailureEvidence, Reason
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import WorkVersionState
from sciretriever.model.sources import (
    MetadataDiscoveryRequest,
    MetadataObservation,
    ProviderDiscoveryResult,
)
from sciretriever.services.literature.api import LiteratureService


@dataclass(frozen=True, slots=True)
class FakeMetadataPort:
    path: Path
    result: ProviderDiscoveryResult
    requests: list[MetadataDiscoveryRequest]

    def search(self, request: MetadataDiscoveryRequest) -> ProviderDiscoveryResult:
        self.requests.append(request)
        with create_or_open_catalog(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.rollback()
        return self.result


class ConflictPublisher:
    def __init__(self, delegate: CollectionAcceptancePublisher, subject: str) -> None:
        self._delegate = delegate
        self._subject = subject

    def publish(self, command: CollectionAcceptance) -> None:
        records = tuple(item.provider_record_id for item in command.bibliography.observations)
        if self._subject in records:
            raise CollectionAcceptanceConflict
        self._delegate.publish(command)


def observation(provider: str, record: str, doi: str) -> MetadataObservation:
    return MetadataObservation(
        provider=provider,
        provider_record_id=record,
        title=f"Title {doi}",
        authors=("Ada",),
        publication_year=2026,
        identifiers=(Identifier(namespace="doi", value=doi),),
        abstract=f"Abstract {doi}",
    )


class TargetCollectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-task14-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)
        self.catalog = self.root / "catalog.sqlite"
        with create_or_open_catalog(self.catalog):
            pass
        self.collection_repository = SqliteCollectionRepository(self.catalog)
        self.bibliography = LiteratureService(
            SqliteLiteratureRepository(self.catalog),
        )
        self.bound = LocalAdmissionBindingFactory().bind_catalog(self.catalog)

    def service(self, sources: tuple[MetadataSource, ...], publisher=None) -> CollectionService:
        selected = CollectionAcceptancePublisher(self.catalog) if publisher is None else publisher
        return CollectionService(
            CollectionServiceDependencies(
                self.collection_repository,
                self.bibliography,
                selected,
                lambda: self.bound.port.acquire_core_write(self.bound.identity),
                sources,
            )
        )

    def test_create_show_and_validation_round_trip_saved_topic_conditions(self) -> None:
        service = self.service(
            (
                MetadataSource(
                    "empty",
                    FakeMetadataPort(
                        self.catalog,
                        ProviderDiscoveryResult(provider="empty", observations=(), failure=None),
                        [],
                    ),
                ),
            )
        )
        conditions = TopicConditions(query=" catalysis ", year_from=2020, year_to=2026, limit=25)

        definition = service.create("Catalysis", " durable topic ", conditions)

        self.assertEqual(service.get(definition.collection_id), definition)
        self.assertEqual(definition.name, "Catalysis")
        self.assertEqual(definition.description, "durable topic")
        self.assertEqual(definition.topic_conditions, validated_topic_conditions(conditions))
        with self.assertRaises(sqlite3.IntegrityError):
            service.create("Catalysis", None, conditions)
        without_topic = service.create("No topic", None, None)
        with self.assertRaises(BoundaryError):
            service.run_topic(without_topic.collection_id, WorkVersionState.UNREVIEWED)
        with open_read_only_snapshot(self.catalog) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM collection_runs WHERE collection_id=?",
                    (str(without_topic.collection_id),),
                ).fetchone(),
                (0,),
            )

    def test_topic_run_reuses_saved_conditions_and_preserves_ordered_partial_results(self) -> None:
        requests: list[MetadataDiscoveryRequest] = []
        crossref = FakeMetadataPort(
            self.catalog,
            ProviderDiscoveryResult(
                provider="crossref",
                observations=(
                    observation("crossref", "crossref-a", "10.1/a"),
                    observation("crossref", "crossref-b", "10.1/b"),
                ),
                failure=None,
            ),
            requests,
        )
        failure = FailureEvidence(
            code="provider-timeout",
            reason=Reason(value="provider deadline exceeded"),
            action=Action(value="retry provider"),
            retryable=True,
        )
        openalex = FakeMetadataPort(
            self.catalog,
            ProviderDiscoveryResult(
                provider="openalex",
                observations=(observation("openalex", "openalex-a", "10.1/a"),),
                failure=failure,
            ),
            requests,
        )
        service = self.service(
            (
                MetadataSource("crossref", crossref),
                MetadataSource("openalex", openalex),
            )
        )
        conditions = TopicConditions(query="catalysis", year_from=2020, year_to=2026, limit=25)
        definition = service.create("Catalysis", None, conditions)

        first = service.run_topic(definition.collection_id, WorkVersionState.COMPLETED)
        second = service.run_topic(definition.collection_id, WorkVersionState.COMPLETED)

        self.assertEqual(
            requests,
            [MetadataDiscoveryRequest(query="catalysis", year_from=2020, year_to=2026, limit=25)]
            * 4,
        )
        self.assertEqual((first.status.value, first.requested_advance_to), ("partial", "completed"))
        self.assertEqual(
            (
                first.counts.discovered,
                first.counts.accepted,
                first.counts.new_members,
                first.counts.existing_members,
                first.counts.source_failures,
            ),
            (3, 2, 2, 0, 1),
        )
        self.assertEqual(
            tuple((item.ordinal, item.source, item.discovered) for item in first.source_results),
            ((0, "crossref", 2), (1, "openalex", 1)),
        )
        self.assertEqual((second.counts.new_members, second.counts.existing_members), (0, 2))
        causes = self.collection_repository.list_causes(
            CausePageRequest(
                collection_id=definition.collection_id,
                after_cause_id=None,
                limit=100,
            ),
        )
        self.assertEqual(len(causes.causes), 6)
        evidence = tuple(parse_canonical_json(cause.evidence) for cause in causes.causes)
        self.assertTrue(
            all(isinstance(item, CanonicalJsonObject) and item.entries for item in evidence)
        )
        with open_read_only_snapshot(self.catalog) as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM collection_memberships").fetchone(), (2,)
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM collection_causes").fetchone(), (6,)
            )
            self.assertEqual(connection.execute("SELECT count(*) FROM batch_runs").fetchone(), (0,))
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM collection_runs WHERE advancement_batch_id IS NOT NULL"
                ).fetchone(),
                (0,),
            )

    def test_publication_conflict_keeps_prior_acceptance_and_records_subject_failure(self) -> None:
        port = FakeMetadataPort(
            self.catalog,
            ProviderDiscoveryResult(
                provider="crossref",
                observations=(
                    observation("crossref", "accepted", "10.1/accepted"),
                    observation("crossref", "conflict", "10.1/conflict"),
                ),
                failure=None,
            ),
            [],
        )
        publisher = ConflictPublisher(CollectionAcceptancePublisher(self.catalog), "conflict")
        service = self.service((MetadataSource("crossref", port),), publisher)
        definition = service.create("Conflicts", None, TopicConditions(query="conflicts"))

        run = service.run_topic(definition.collection_id, WorkVersionState.UNREVIEWED)

        self.assertEqual((run.counts.accepted, run.counts.missing), (1, 1))
        self.assertEqual(run.source_results[0].failure_code, "publication-conflict")
        reason = run.source_results[0].failure_reason
        assert reason is not None
        self.assertIn("conflict", reason)
        with open_read_only_snapshot(self.catalog) as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM collection_memberships").fetchone(), (1,)
            )
            self.assertEqual(connection.execute("SELECT count(*) FROM works").fetchone(), (1,))
            self.assertEqual(connection.execute("SELECT count(*) FROM batch_runs").fetchone(), (0,))


if __name__ == "__main__":
    unittest.main()
