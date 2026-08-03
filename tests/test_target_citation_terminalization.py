from __future__ import annotations

import sqlite3
import unittest
from dataclasses import dataclass

from target_citation_fixture import CitationCollectionTestCase, FakeCitationPort
from test_target_collection import FakeMetadataPort

from sciretriever.infrastructure.storage.sqlite import (
    CollectionAcceptancePublisher,
    SqliteCollectionRepository,
    open_read_only_snapshot,
)
from sciretriever.model.collection import (
    CitationCollectionRequest,
    FinishCollectionRun,
    MembershipPageRequest,
    WorkSeed,
)
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import (
    CitationDirection,
    WorkVersionState,
)
from sciretriever.model.sources import (
    CitationDiscoveryRequest,
    CitationObservation,
    ProviderCitationResult,
    ProviderDiscoveryResult,
)
from sciretriever.services.collection.api import (
    CitationSource,
    CollectionService,
    CollectionServiceDependencies,
    MetadataSource,
)


@dataclass(frozen=True, slots=True)
class RaisingCitationPort:
    error: Exception | KeyboardInterrupt

    def expand(self, request: CitationDiscoveryRequest) -> ProviderCitationResult:
        raise self.error


@dataclass(frozen=True, slots=True)
class WrongProviderPort:
    def expand(self, request: CitationDiscoveryRequest) -> ProviderCitationResult:
        observation = CitationObservation(
            provider="wrong",
            source_work_id=request.seed,
            target_identifier=Identifier(namespace="doi", value="10.1/wrong"),
            direction=request.direction,
        )
        return ProviderCitationResult(provider="wrong", observations=(observation,), failure=None)


class FailingFinishRepository(SqliteCollectionRepository):
    def __init__(self, catalog) -> None:
        super().__init__(catalog)
        self.finish_calls = 0

    def finish_run(self, command: FinishCollectionRun):
        self.finish_calls += 1
        raise sqlite3.OperationalError("finish failed")


class TargetCitationTerminalizationTests(CitationCollectionTestCase):
    def request(self, work_id, providers: tuple[str, ...]) -> CitationCollectionRequest:
        return CitationCollectionRequest(
            seed_selectors=(WorkSeed(work_id=work_id),),
            providers=providers,
            direction=CitationDirection.REFERENCES,
            depth=1,
            max_new=10,
        )

    def rows(self, collection_id):
        with open_read_only_snapshot(self.catalog) as connection:
            run = connection.execute(
                "SELECT id,status,discovered_count,accepted_count,new_member_count,"
                "existing_member_count,missing_count,source_failure_count FROM collection_runs "
                "WHERE collection_id=? ORDER BY created_at DESC LIMIT 1",
                (str(collection_id),),
            ).fetchone()
            sources = connection.execute(
                "SELECT source_ordinal,source_name,discovered_count,accepted_count,missing_count,"
                "failure_code FROM collection_source_results WHERE collection_run_id=? "
                "ORDER BY source_ordinal",
                (run[0],),
            ).fetchall()
            running = connection.execute(
                "SELECT count(*) FROM collection_runs WHERE status='running'",
            ).fetchone()[0]
        return run, sources, running

    def test_runtime_error_after_seed_is_local_failure_and_restart_has_zero_running(self) -> None:
        _, seed = self.add_work("10.1/runtime-seed")
        source = CitationSource("broken", RaisingCitationPort(RuntimeError("secret adapter bug")))
        service = self.service((source,))
        target = service.create("runtime-seed", None, None)

        first = service.run_citation(
            target.collection_id,
            self.request(seed.work_id, ("broken",)),
            WorkVersionState.UNREVIEWED,
        )
        second = service.run_citation(
            target.collection_id,
            self.request(seed.work_id, ("broken",)),
            WorkVersionState.UNREVIEWED,
        )

        run, sources, running = self.rows(target.collection_id)
        self.assertEqual(first.status.value, "partial")
        self.assertEqual(second.status.value, "partial")
        self.assertEqual(run[1:], ("partial", 0, 0, 0, 0, 0, 1))
        self.assertEqual(sources, [(0, "broken", 0, 0, 0, "provider-execution-failed")])
        self.assertEqual(running, 0)

    def test_runtime_error_after_first_success_preserves_prefix_and_sibling_rows(self) -> None:
        _, seed = self.add_work("10.1/prefix-seed")
        _, target_work = self.add_work("10.1/prefix-target")
        calls: list[CitationDiscoveryRequest] = []
        successful = FakeCitationPort(
            self.catalog,
            {
                (str(seed.work_id), CitationDirection.REFERENCES): (
                    Identifier(namespace="doi", value="10.1/prefix-target"),
                ),
            },
            "good",
            calls,
        )
        service = self.service(
            (
                CitationSource("good", successful),
                CitationSource("broken", RaisingCitationPort(RuntimeError("adapter bug"))),
            )
        )
        target = service.create("prefix", None, None)

        service.run_citation(
            target.collection_id,
            self.request(seed.work_id, ("good", "broken")),
            WorkVersionState.UNREVIEWED,
        )

        run, sources, running = self.rows(target.collection_id)
        self.assertEqual(run[1:], ("partial", 1, 1, 1, 0, 0, 1))
        self.assertEqual(
            sources,
            [
                (0, "good", 1, 1, 0, None),
                (1, "broken", 0, 0, 0, "provider-execution-failed"),
            ],
        )
        self.assertEqual(running, 0)
        self.assertIn(
            target_work.work_id,
            tuple(
                item.work_id
                for item in self.collections.list_memberships(
                    MembershipPageRequest(
                        collection_id=target.collection_id,
                        after_work_id=None,
                        limit=100,
                    )
                ).members
            ),
        )

    def test_malformed_provider_result_is_sanitized_and_terminal(self) -> None:
        _, seed = self.add_work("10.1/malformed")
        service = self.service((CitationSource("expected", WrongProviderPort()),))
        target = service.create("malformed", None, None)

        service.run_citation(
            target.collection_id,
            self.request(seed.work_id, ("expected",)),
            WorkVersionState.UNREVIEWED,
        )

        run, sources, running = self.rows(target.collection_id)
        self.assertEqual(run[1:], ("partial", 0, 0, 0, 0, 0, 1))
        self.assertEqual(sources, [(0, "expected", 0, 0, 0, "provider-invalid-response")])
        self.assertEqual(running, 0)

    def test_keyboard_interrupt_persists_completed_prefix_releases_lock_and_reraises(self) -> None:
        _, seed = self.add_work("10.1/interrupt-seed")
        _, target_work = self.add_work("10.1/interrupt-target")
        good = FakeCitationPort(
            self.catalog,
            {
                (str(seed.work_id), CitationDirection.REFERENCES): (
                    Identifier(namespace="doi", value="10.1/interrupt-target"),
                ),
            },
            "good",
            [],
        )
        service = self.service(
            (
                CitationSource("good", good),
                CitationSource("interrupt", RaisingCitationPort(KeyboardInterrupt())),
            )
        )
        target = service.create("interrupt", None, None)

        with self.assertRaises(KeyboardInterrupt):
            service.run_citation(
                target.collection_id,
                self.request(seed.work_id, ("good", "interrupt")),
                WorkVersionState.UNREVIEWED,
            )

        run, sources, running = self.rows(target.collection_id)
        self.assertEqual(run[1:], ("interrupted", 1, 1, 1, 0, 0, 1))
        self.assertEqual(sources[-1], (1, "interrupt", 0, 0, 0, "interrupted"))
        self.assertEqual(running, 0)
        with self.bound.port.acquire_core_write(self.bound.identity):
            self.assertEqual(target_work.work_id, target_work.work_id)

    def test_finish_failure_propagates_and_is_attempted_once(self) -> None:
        _, seed = self.add_work("10.1/finish")
        repository = FailingFinishRepository(self.catalog)
        metadata = FakeMetadataPort(
            self.catalog,
            ProviderDiscoveryResult(provider="seed", observations=(), failure=None),
            [],
        )
        source = CitationSource("empty", FakeCitationPort(self.catalog, {}, "empty", []))
        service = CollectionService(
            CollectionServiceDependencies(
                repository,
                self.bibliography,
                CollectionAcceptancePublisher(self.catalog),
                lambda: self.bound.port.acquire_core_write(self.bound.identity),
                (MetadataSource("seed", metadata),),
                (source,),
            )
        )
        target = service.create("finish", None, None)

        with self.assertRaisesRegex(sqlite3.OperationalError, "finish failed"):
            service.run_citation(
                target.collection_id,
                self.request(seed.work_id, ("empty",)),
                WorkVersionState.UNREVIEWED,
            )

        self.assertEqual(repository.finish_calls, 1)
        with self.bound.port.acquire_core_write(self.bound.identity):
            self.assertEqual(repository.finish_calls, 1)


if __name__ == "__main__":
    unittest.main()
