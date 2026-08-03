from __future__ import annotations

import os
import unittest

from target_citation_fixture import CitationCollectionTestCase, FakeCitationPort
from test_target_collection import FakeMetadataPort

from sciretriever.infrastructure.storage.sqlite import (
    CollectionAcceptancePublisher,
    SqliteCollectionRepository,
    open_read_only_snapshot,
)
from sciretriever.model.collection import (
    CitationCollectionRequest,
    CollectionRunRecord,
    MembershipPageRequest,
    WorkSeed,
)
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import (
    CitationDirection,
    CollectionId,
    CollectionRunId,
    WorkId,
    WorkVersionState,
)
from sciretriever.model.sources import ProviderDiscoveryResult
from sciretriever.services.collection.api import (
    CitationSource,
    CollectionService,
    CollectionServiceDependencies,
    MetadataSource,
)


class PublisherFailure(RuntimeError):
    pass


class CountingCollectionRepository(SqliteCollectionRepository):
    def __init__(self, catalog: str | os.PathLike[str]) -> None:
        super().__init__(catalog)
        self.finish_calls = 0

    def finish_run(self, command):
        self.finish_calls += 1
        return super().finish_run(command)


class FailingPublisher:
    def __init__(
        self, catalog: str | os.PathLike[str], failure: BaseException, fail_after: int
    ) -> None:
        self.delegate = CollectionAcceptancePublisher(catalog)
        self.failure = failure
        self.fail_after = fail_after
        self.calls = 0

    def publish(self, command) -> None:
        if self.calls >= self.fail_after:
            raise self.failure
        self.calls += 1
        self.delegate.publish(command)

    def publish_existing(self, command) -> None:
        self.delegate.publish_existing(command)


class TargetCollectionServiceFailureTests(CitationCollectionTestCase):
    def _service(
        self,
        failure: BaseException,
        fail_after: int,
        records: tuple[str, ...],
    ) -> tuple[CollectionService, CountingCollectionRepository, CollectionId, WorkId]:
        _, seed = self.add_work("10.1/failure-seed")
        repository = CountingCollectionRepository(self.catalog)
        citation = FakeCitationPort(
            self.catalog,
            {
                (str(seed.work_id), CitationDirection.REFERENCES): tuple(
                    Identifier(namespace="doi", value=record) for record in records
                )
            },
            "citation",
            [],
        )
        metadata = FakeMetadataPort(
            self.catalog,
            ProviderDiscoveryResult(provider="seed", observations=(), failure=None),
            [],
        )
        service = CollectionService(
            CollectionServiceDependencies(
                repository,
                self.bibliography,
                FailingPublisher(self.catalog, failure, fail_after),
                lambda: self.bound.port.acquire_core_write(self.bound.identity),
                (MetadataSource("seed", metadata),),
                (CitationSource("citation", citation),),
            )
        )
        collection = service.create("Failure target", None, None)
        return service, repository, collection.collection_id, seed.work_id

    @staticmethod
    def _request(seed: WorkId, max_new: int) -> CitationCollectionRequest:
        return CitationCollectionRequest(
            seed_selectors=(WorkSeed(work_id=seed),),
            providers=("citation",),
            direction=CitationDirection.REFERENCES,
            depth=1,
            max_new=max_new,
        )

    def _latest(
        self, repository: CountingCollectionRepository, collection_id: CollectionId
    ) -> CollectionRunRecord:
        with open_read_only_snapshot(self.catalog) as connection:
            row = connection.execute(
                "SELECT id FROM collection_runs "
                "WHERE collection_id=? ORDER BY created_at DESC LIMIT 1",
                (str(collection_id),),
            ).fetchone()
        record = repository.get_run(CollectionRunId(row[0]))
        if record is None:
            self.fail("collection run was not persisted")
        return record

    def test_publisher_failure_terminalizes_missing_observation_and_rethrows(self) -> None:
        failure = PublisherFailure("publisher")
        service, repository, collection_id, seed = self._service(failure, 0, ("target",))

        with self.assertRaises(PublisherFailure) as raised:
            service.run_citation(
                collection_id,
                self._request(seed, 2),
                WorkVersionState.UNREVIEWED,
            )

        self.assertIs(raised.exception, failure)
        record = self._latest(repository, collection_id)
        self.assertEqual(record.status.value, "failed")
        assert record.counts is not None
        self.assertEqual(
            (record.counts.discovered, record.counts.accepted, record.counts.missing), (1, 0, 1)
        )
        self.assertEqual(repository.finish_calls, 1)

    def test_keyboard_interrupt_terminalizes_missing_observation_and_rethrows(self) -> None:
        failure = KeyboardInterrupt()
        service, repository, collection_id, seed = self._service(failure, 0, ("target",))

        with self.assertRaises(KeyboardInterrupt) as raised:
            service.run_citation(
                collection_id,
                self._request(seed, 2),
                WorkVersionState.UNREVIEWED,
            )

        self.assertIs(raised.exception, failure)
        record = self._latest(repository, collection_id)
        self.assertEqual(record.status.value, "interrupted")
        assert record.counts is not None
        self.assertEqual(
            (record.counts.discovered, record.counts.accepted, record.counts.missing), (1, 0, 1)
        )
        self.assertEqual(repository.finish_calls, 1)

    def test_completed_prefix_is_preserved_before_later_publisher_failure(self) -> None:
        failure = PublisherFailure("second publisher")
        service, repository, collection_id, seed = self._service(
            failure, 1, ("target", "target-two")
        )

        with self.assertRaises(PublisherFailure) as raised:
            service.run_citation(
                collection_id,
                self._request(seed, 3),
                WorkVersionState.UNREVIEWED,
            )

        self.assertIs(raised.exception, failure)
        record = self._latest(repository, collection_id)
        self.assertEqual(record.status.value, "failed")
        assert record.counts is not None
        self.assertEqual(
            (record.counts.discovered, record.counts.accepted, record.counts.missing), (2, 1, 1)
        )
        self.assertEqual(
            len(
                repository.list_memberships(
                    MembershipPageRequest(
                        collection_id=collection_id,
                        after_work_id=None,
                        limit=100,
                    )
                ).members
            ),
            2,
        )
        self.assertEqual(repository.finish_calls, 1)


if __name__ == "__main__":
    unittest.main()
