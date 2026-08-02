from __future__ import annotations

import unittest
from dataclasses import dataclass

from test_target_collection import (
    FakeMetadataPort,
    TargetCollectionTests,
    observation,
)

from sciretriever.collection.service import MetadataSource
from sciretriever.literature_store.sqlite import (
    CollectionAcceptancePublisher,
    open_read_only_snapshot,
)
from sciretriever.model.collection import CollectionAcceptance, TopicConditions
from sciretriever.model.primitives import WorkVersionState
from sciretriever.model.sources import MetadataDiscoveryRequest, ProviderDiscoveryResult


@dataclass(frozen=True, slots=True)
class RaisingMetadataPort:
    error: RuntimeError

    def search(self, request: MetadataDiscoveryRequest) -> ProviderDiscoveryResult:
        raise self.error


class InterruptingPublisher:
    def __init__(self, delegate: CollectionAcceptancePublisher, subject: str) -> None:
        self._delegate = delegate
        self._subject = subject

    def publish(self, command: CollectionAcceptance) -> None:
        records = tuple(item.provider_record_id for item in command.bibliography.observations)
        if self._subject in records:
            raise KeyboardInterrupt
        self._delegate.publish(command)


class TargetCollectionLifecycleTests(TargetCollectionTests):
    def test_exact_same_source_subject_is_counted_and_published_once(self) -> None:
        repeated = observation("dup", "same", "10.1/same")
        port = FakeMetadataPort(
            self.catalog,
            ProviderDiscoveryResult(
                provider="dup", observations=(repeated, repeated), failure=None
            ),
            [],
        )
        service = self.service((MetadataSource("dup", port),))
        definition = service.create("Exact duplicate", None, TopicConditions(query="duplicate"))

        run = service.run_topic(definition.collection_id, WorkVersionState.UNREVIEWED)
        restarted = self.collection_repository.get_run(run.run_id)

        self.assertEqual(restarted, run)
        self.assertEqual((run.counts.discovered, run.counts.accepted), (1, 1))
        self.assertEqual(run.source_results[0].discovered, 1)
        with open_read_only_snapshot(self.catalog) as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM collection_memberships").fetchone(), (1,)
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM collection_causes").fetchone(), (1,)
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM collection_runs WHERE status='running'"
                ).fetchone(),
                (0,),
            )

    def test_conflicting_same_source_subject_keeps_first_fact_and_records_failure(self) -> None:
        first = observation("dup", "same", "10.1/same")
        conflicting = observation("dup", "same", "10.1/different")
        port = FakeMetadataPort(
            self.catalog,
            ProviderDiscoveryResult(
                provider="dup", observations=(first, conflicting), failure=None
            ),
            [],
        )
        service = self.service((MetadataSource("dup", port),))
        definition = service.create(
            "Conflicting duplicate", None, TopicConditions(query="duplicate")
        )

        run = service.run_topic(definition.collection_id, WorkVersionState.UNREVIEWED)

        self.assertEqual(
            (run.counts.discovered, run.counts.accepted, run.counts.missing), (1, 1, 0)
        )
        self.assertEqual(run.source_results[0].failure_code, "conflicting-source-subject")
        with open_read_only_snapshot(self.catalog) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM works").fetchone(), (1,))
            self.assertEqual(
                connection.execute("SELECT count(*) FROM collection_causes").fetchone(), (1,)
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM collection_runs WHERE status='running'"
                ).fetchone(),
                (0,),
            )

    def test_exception_after_first_source_terminalizes_prefix_before_reraise(self) -> None:
        first = FakeMetadataPort(
            self.catalog,
            ProviderDiscoveryResult(
                provider="first",
                observations=(observation("first", "accepted", "10.1/accepted"),),
                failure=None,
            ),
            [],
        )
        service = self.service(
            (
                MetadataSource("first", first),
                MetadataSource("broken", RaisingMetadataPort(RuntimeError("provider exploded"))),
            )
        )
        definition = service.create("Exception", None, TopicConditions(query="exception"))

        with self.assertRaisesRegex(RuntimeError, "provider exploded"):
            service.run_topic(definition.collection_id, WorkVersionState.UNREVIEWED)

        with open_read_only_snapshot(self.catalog) as connection:
            row = connection.execute(
                "SELECT id,status,accepted_count FROM collection_runs WHERE collection_id=?",
                (str(definition.collection_id),),
            ).fetchone()
            self.assertEqual(row[1:], ("failed", 1))
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM collection_source_results WHERE collection_run_id=?",
                    (row[0],),
                ).fetchone(),
                (1,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM collection_runs WHERE status='running'"
                ).fetchone(),
                (0,),
            )

    def test_interruption_terminalizes_completed_subject_prefix_before_reraise(self) -> None:
        port = FakeMetadataPort(
            self.catalog,
            ProviderDiscoveryResult(
                provider="source",
                observations=(
                    observation("source", "accepted", "10.1/accepted"),
                    observation("source", "interrupt", "10.1/interrupt"),
                ),
                failure=None,
            ),
            [],
        )
        publisher = InterruptingPublisher(CollectionAcceptancePublisher(self.catalog), "interrupt")
        service = self.service((MetadataSource("source", port),), publisher)
        definition = service.create("Interrupted", None, TopicConditions(query="interrupt"))

        with self.assertRaises(KeyboardInterrupt):
            service.run_topic(definition.collection_id, WorkVersionState.UNREVIEWED)

        with open_read_only_snapshot(self.catalog) as connection:
            row = connection.execute(
                "SELECT id,status,discovered_count,accepted_count "
                "FROM collection_runs WHERE collection_id=?",
                (str(definition.collection_id),),
            ).fetchone()
            self.assertEqual(row[1:], ("interrupted", 1, 1))
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM collection_source_results WHERE collection_run_id=?",
                    (row[0],),
                ).fetchone(),
                (1,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM collection_runs WHERE status='running'"
                ).fetchone(),
                (0,),
            )


if __name__ == "__main__":
    unittest.main()
