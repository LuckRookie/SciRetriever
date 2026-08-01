from __future__ import annotations

import os
import multiprocessing
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from sciretriever.bibliography.model import (
    CurationScope, CurationStaleError, IdentityCandidateQuery,
    ValidatedCurationPlan, VersionMove,
)
from sciretriever.collection.model import (
    CollectionCounts, CollectionDefinition, CollectionRunStatus,
    CollectionSourceResult, CreateCollectionDefinition, FinishCollectionRun,
    MembershipPageRequest, StartCollectionRun,
    ValidatedTopicConditionSet,
)
from sciretriever.kernel import (
    BatchRunId, CanonicalJsonObject, CollectionId, CollectionRunId, CurationPlanId,
    ExtensionRecordId, Identifier, Sha256, UtcTimestamp, WorkId, WorkVersionId,
)
from sciretriever.literature_store.filesystem import (
    AdmissionBindingError, AdmissionConflictError, AdmissionOrderError,
    LocalAdmissionBindingFactory,
)
from sciretriever.literature_store.sqlite import (
    OpaqueExtensionConflictError, OpaqueExtensionRecordStore, SqliteBibliographyRepository,
    SqliteCollectionRepository, SqliteCurationTransaction, create_or_open_catalog,
)


UUIDS = tuple(f"00000000-0000-4000-8000-{index:012d}" for index in range(1, 20))


class InjectedFailure(Exception):
    pass


def _contend_core(catalog: str, queue: multiprocessing.Queue[str]) -> None:
    bound = LocalAdmissionBindingFactory().bind_catalog(catalog)
    try:
        with bound.port.acquire_core_write(bound.identity):
            queue.put("acquired")
    except AdmissionConflictError:
        queue.put("conflict")


class TargetStorePortTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-task8-")
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)
        self.catalog = self.root / "catalog.sqlite"
        with create_or_open_catalog(self.catalog):
            pass

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def seed_bibliography(self) -> tuple[WorkId, WorkVersionId, WorkId]:
        left, version, right = WorkId(UUIDS[0]), WorkVersionId(UUIDS[1]), WorkId(UUIDS[2])
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute("INSERT INTO works(id) VALUES(?),(?)", (str(left), str(right)))
            connection.execute(
                "INSERT INTO work_versions(id,work_id,version_role) VALUES(?,?,'formal')",
                (str(version), str(left)),
            )
            connection.execute(
                "INSERT INTO stable_identifiers(id,work_version_id,namespace,value) VALUES(?,?,?,?)",
                (UUIDS[3], str(version), "doi", "10.1/test"),
            )
            connection.commit()
        return left, version, right

    def test_collection_repository_round_trip_and_membership_page(self) -> None:
        repository = SqliteCollectionRepository(self.catalog)
        conditions = ValidatedTopicConditionSet("{}", Sha256.from_bytes(b"{}"))
        definition = CollectionDefinition(
            CollectionId(UUIDS[0]), "topic", None, conditions, UtcTimestamp("2026-07-31T00:00:00Z"),
        )
        repository.create_definition(CreateCollectionDefinition(definition))
        run = repository.start_run(StartCollectionRun(
            CollectionRunId(UUIDS[1]), definition.collection_id, "topic", conditions, None, "completed",
        ))
        counts = CollectionCounts(3, 2, 1, 1, 1, 1)
        sources = (
            CollectionSourceResult(0, "crossref", 2, 2, 0),
            CollectionSourceResult(
                1, "openalex", 1, 0, 1,
                "provider-timeout", "provider timed out", "retry provider", True,
            ),
        )
        finished = repository.finish_run(FinishCollectionRun(
            run.run_id, CollectionRunStatus.PARTIAL, "source-failure", counts, sources,
        ))
        self.assertEqual(repository.get_definition(definition.collection_id), definition)
        self.assertEqual((finished.counts, finished.source_results), (counts, sources))
        self.assertEqual(repository.get_run(run.run_id), finished)
        self.assertEqual(repository.list_memberships(MembershipPageRequest(definition.collection_id, None, 2)).members, ())

    def test_bibliography_facts_and_identity_candidates_use_real_sqlite(self) -> None:
        work, version, _ = self.seed_bibliography()
        repository = SqliteBibliographyRepository(self.catalog)
        candidates = repository.find_identity_candidates(IdentityCandidateQuery((Identifier("doi", "10.1/test"),)))
        self.assertEqual((candidates.candidates[0].work_id, candidates.candidates[0].work_version_id), (work, version))
        self.assertEqual(repository.get_work_facts(work).version_ids, (version,))
        self.assertEqual(repository.get_version_facts(version).work_id, work)

    def test_curation_applies_exact_move_and_rejects_stale_token(self) -> None:
        work, version, target = self.seed_bibliography()
        repository = SqliteBibliographyRepository(self.catalog)
        scope = CurationScope((work, target), (version,))
        snapshot = repository.load_curation_snapshot(scope)
        plan = ValidatedCurationPlan(
            CurationPlanId(UUIDS[4]), scope, snapshot.token,
            version_moves=(VersionMove(version, target),),
        )
        SqliteCurationTransaction(self.catalog).apply(plan)
        self.assertEqual(repository.get_version_facts(version).work_id, target)
        with self.assertRaises(CurationStaleError):
            SqliteCurationTransaction(self.catalog).apply(plan)

    def test_curation_failpoint_rolls_back_whole_plan(self) -> None:
        work, version, target = self.seed_bibliography()
        repository = SqliteBibliographyRepository(self.catalog)
        scope = CurationScope((work, target), (version,))
        snapshot = repository.load_curation_snapshot(scope)
        plan = ValidatedCurationPlan(
            CurationPlanId(UUIDS[4]), scope, snapshot.token,
            version_moves=(VersionMove(version, target),),
        )
        def fail(name: str) -> None:
            if name == "versions":
                raise InjectedFailure
        with self.assertRaises(InjectedFailure):
            SqliteCurationTransaction(self.catalog, fail).apply(plan)
        self.assertEqual(repository.get_version_facts(version).work_id, work)

    def test_admission_binding_conflict_order_and_forgery(self) -> None:
        factory = LocalAdmissionBindingFactory()
        bound = factory.bind_catalog(self.catalog)
        output = factory.bind_output(self.root / "export.json")
        with bound.port.acquire_core_write(bound.identity):
            with self.assertRaises(AdmissionConflictError):
                bound.port.acquire_core_write(bound.identity)
            with bound.port.acquire_exchange_batch_owner(BatchRunId(UUIDS[5])):
                with bound.port.acquire_output_path(output):
                    pass
        with bound.port.acquire_output_path(output):
            with self.assertRaises(AdmissionOrderError):
                bound.port.acquire_core_write(bound.identity)
        forged = type(bound.identity)(bound.identity.binding_id, Sha256.from_bytes(b"forged"))
        with self.assertRaises(AdmissionBindingError):
            bound.port.acquire_core_write(forged)

    def test_core_write_conflicts_across_real_processes(self) -> None:
        bound = LocalAdmissionBindingFactory().bind_catalog(self.catalog)
        queue: multiprocessing.Queue[str] = multiprocessing.Queue()
        with bound.port.acquire_core_write(bound.identity):
            process = multiprocessing.Process(target=_contend_core, args=(str(self.catalog), queue))
            process.start()
            process.join(5)
        self.assertEqual((process.exitcode, queue.get(timeout=1)), (0, "conflict"))

    def test_opaque_namespace_pagination_and_cas_remain_payload_agnostic(self) -> None:
        store = OpaqueExtensionRecordStore(self.catalog)
        identifiers = tuple(ExtensionRecordId(value) for value in UUIDS[6:9])
        for index, identifier in enumerate(reversed(identifiers)):
            store.compare_and_set(
                "opaque.test", identifier, None,
                CanonicalJsonObject((("uninterpreted", index),)),
            )
        first = store.list_namespace("opaque.test", None, 2)
        second = store.list_namespace("opaque.test", first[-1].record_id, 2)
        self.assertEqual(tuple(item.record_id for item in first + second), identifiers)
        with self.assertRaises(OpaqueExtensionConflictError):
            store.compare_and_set(
                "opaque.test", identifiers[0], 9,
                CanonicalJsonObject((("different", True),)),
            )


if __name__ == "__main__":
    unittest.main()
