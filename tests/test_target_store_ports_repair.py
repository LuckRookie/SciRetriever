from __future__ import annotations

import os
import sqlite3
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from pydantic import ValidationError

from sciretriever.collection.run_results import validate_finish_collection_run
from sciretriever.core.literature.curation import CurationPlanError, validate_curation_plan
from sciretriever.kernel.errors import BoundaryError
from sciretriever.literature_store.filesystem import (
    AdmissionOrderError,
    FilesystemSafetyError,
    LocalAdmissionBindingFactory,
)
from sciretriever.literature_store.sqlite import (
    SqliteCurationTransaction,
    SqliteLiteratureRepository,
    create_or_open_catalog,
)
from sciretriever.model.collection import CollectionCounts, FinishCollectionRun
from sciretriever.model.library import (
    CurationScope,
    MembershipMove,
    ReferenceRetarget,
    SnapshotToken,
    ValidatedCurationPlan,
)
from sciretriever.model.primitives import (
    BatchRunId,
    CollectionRunId,
    CollectionRunStatus,
    CurationPlanId,
    MembershipId,
    ReferenceFactId,
    WorkId,
    WorkVersionId,
    sha256_digest,
)

UUIDS = tuple(f"10000000-0000-4000-8000-{value:012d}" for value in range(1, 40))


class TargetStorePortRepairTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-task8-repair-")
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)
        self.catalog = self.root / "catalog.sqlite"
        with create_or_open_catalog(self.catalog):
            pass

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def seed_collection_membership(self) -> tuple[CurationScope, str, str]:
        work = WorkId(UUIDS[0])
        version = WorkVersionId(UUIDS[1])
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute("INSERT INTO works(id) VALUES(?)", (str(work),))
            connection.execute(
                "INSERT INTO work_versions(id,work_id,version_role) VALUES(?,?,'formal')",
                (str(version), str(work)),
            )
            connection.execute("INSERT INTO collections(id,name) VALUES(?,'a')", (UUIDS[2],))
            connection.execute(
                "INSERT INTO collection_runs(id,collection_id,mode,topic_conditions_json,"
                "requested_advance_to,status) "
                "VALUES(?,?,'topic','{}','completed','completed')",
                (UUIDS[3], UUIDS[2]),
            )
            connection.execute(
                "INSERT INTO collection_memberships("
                "id,collection_id,work_id,first_collection_run_id) VALUES(?,?,?,?)",
                (UUIDS[4], UUIDS[2], str(work), UUIDS[3]),
            )
            connection.execute(
                "INSERT INTO collection_causes("
                "id,membership_id,collection_run_id,kind,source) "
                "VALUES(?,?,?,'seed','before')",
                (UUIDS[5], UUIDS[4], UUIDS[3]),
            )
            connection.execute(
                "INSERT INTO collection_paths("
                "id,membership_id,collection_run_id,direction,depth,work_ids_json) "
                "VALUES(?,?,?,'references',0,'[]')",
                (UUIDS[6], UUIDS[4], UUIDS[3]),
            )
            connection.commit()
        return (
            CurationScope(work_ids=(work,), work_version_ids=(version,)),
            UUIDS[5],
            UUIDS[6],
        )

    def test_catalog_and_output_bindings_reject_post_bind_replacement(self) -> None:
        factory = LocalAdmissionBindingFactory()
        bound = factory.bind_catalog(self.catalog)
        replacement = self.root / "replacement.sqlite"
        with create_or_open_catalog(replacement):
            pass
        self.catalog.unlink()
        os.link(replacement, self.catalog)
        with self.assertRaises(FilesystemSafetyError):
            bound.port.acquire_core_write(bound.identity)

        absent = self.root / "absent.json"
        output = factory.bind_output(absent)
        absent.symlink_to(replacement)
        with self.assertRaises(FilesystemSafetyError):
            bound.port.acquire_output_path(output)

    def test_existing_output_replacement_rejects_and_guarded_creation_rebinds(self) -> None:
        existing = self.root / "existing.json"
        existing.touch(mode=0o600)
        factory = LocalAdmissionBindingFactory()
        bound = factory.bind_catalog(self.catalog)
        output = factory.bind_output(existing)
        existing.unlink()
        replacement = self.root / "replacement.json"
        replacement.touch(mode=0o600)
        os.link(replacement, existing)
        with self.assertRaises(FilesystemSafetyError):
            bound.port.acquire_output_path(output)
        created = self.root / "created.json"
        created_identity = factory.bind_output(created)
        with bound.port.acquire_output_path(created_identity):
            descriptor = os.open(created, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(descriptor)
        with bound.port.acquire_output_path(created_identity):
            pass

    def test_order_is_shared_across_ports_but_isolated_between_threads(self) -> None:
        other = self.root / "other.sqlite"
        with create_or_open_catalog(other):
            pass
        factory = LocalAdmissionBindingFactory()
        left = factory.bind_catalog(self.catalog)
        right = factory.bind_catalog(other)
        output = factory.bind_output(self.root / "out.json")
        with left.port.acquire_output_path(output):
            with self.assertRaises(AdmissionOrderError):
                right.port.acquire_core_write(right.identity)
            outcomes: list[str] = []

            def acquire_in_thread() -> None:
                with right.port.acquire_core_write(right.identity):
                    outcomes.append("acquired")

            thread = threading.Thread(target=acquire_in_thread)
            thread.start()
            thread.join()
        with left.port.acquire_exchange_batch_owner(BatchRunId(UUIDS[7])):
            with self.assertRaises(AdmissionOrderError):
                right.port.acquire_core_write(right.identity)
        with right.port.acquire_package_owner(right.identity, WorkVersionId(UUIDS[8])):
            with left.port.acquire_output_path(output):
                pass
        self.assertEqual(outcomes, ["acquired"])

    def test_finish_command_rejects_nonterminal_and_reason_mismatches(self) -> None:
        counts = CollectionCounts(
            discovered=0,
            accepted=0,
            new_members=0,
            existing_members=0,
            missing=0,
            source_failures=0,
        )

        def command(status: CollectionRunStatus, reason: str | None) -> FinishCollectionRun:
            return FinishCollectionRun(
                run_id=CollectionRunId(UUIDS[0]),
                status=status,
                stop_reason=reason,
                counts=counts,
                source_results=(),
            )

        for status in (CollectionRunStatus.CREATED, CollectionRunStatus.RUNNING):
            with self.subTest(status=status), self.assertRaises(BoundaryError):
                validate_finish_collection_run(command(status, None))
        with self.assertRaises(BoundaryError):
            validate_finish_collection_run(command(CollectionRunStatus.FAILED, None))
        with self.assertRaises(BoundaryError):
            validate_finish_collection_run(command(CollectionRunStatus.NO_TARGET, "reason"))
        completed = command(CollectionRunStatus.COMPLETED, "reason")
        validate_finish_collection_run(completed)
        self.assertEqual(completed.stop_reason, "reason")
        with self.assertRaises(ValidationError):
            command(CollectionRunStatus.COMPLETED, " ")

    def test_cause_and_path_mutations_change_snapshot_token(self) -> None:
        scope, cause_id, path_id = self.seed_collection_membership()
        repository = SqliteLiteratureRepository(self.catalog)
        original = repository.load_curation_snapshot(scope).token
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute(
                "UPDATE collection_causes SET source='after' WHERE id=?", (cause_id,)
            )
            connection.commit()
        after_cause = repository.load_curation_snapshot(scope).token
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute("UPDATE collection_paths SET depth=1 WHERE id=?", (path_id,))
            connection.commit()
        self.assertNotEqual(original, after_cause)
        self.assertNotEqual(after_cause, repository.load_curation_snapshot(scope).token)

    def test_cross_collection_coalesce_rejects_and_rolls_back(self) -> None:
        scope, _, _ = self.seed_collection_membership()
        target_work = WorkId(UUIDS[8])
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute("INSERT INTO works(id) VALUES(?)", (str(target_work),))
            connection.execute("INSERT INTO collections(id,name) VALUES(?,'b')", (UUIDS[9],))
            connection.execute(
                "INSERT INTO collection_runs(id,collection_id,mode,topic_conditions_json,"
                "requested_advance_to,status) "
                "VALUES(?,?,'topic','{}','completed','completed')",
                (UUIDS[10], UUIDS[9]),
            )
            connection.execute(
                "INSERT INTO collection_memberships("
                "id,collection_id,work_id,first_collection_run_id) VALUES(?,?,?,?)",
                (UUIDS[11], UUIDS[9], str(target_work), UUIDS[10]),
            )
            connection.commit()
        expanded = CurationScope(
            work_ids=scope.work_ids + (target_work,),
            work_version_ids=scope.work_version_ids,
        )
        token = SqliteLiteratureRepository(self.catalog).load_curation_snapshot(expanded).token
        plan = ValidatedCurationPlan(
            plan_id=CurationPlanId(UUIDS[12]),
            scope=expanded,
            expected_snapshot=token,
            membership_moves=(
                MembershipMove(
                    membership_id=MembershipId(UUIDS[4]),
                    target_work_id=target_work,
                    coalesce_membership_id=MembershipId(UUIDS[11]),
                ),
            ),
        )
        with self.assertRaises(sqlite3.IntegrityError):
            SqliteCurationTransaction(self.catalog).apply(plan)
        with create_or_open_catalog(self.catalog) as connection:
            row = connection.execute(
                "SELECT collection_id FROM collection_memberships WHERE id=?", (UUIDS[4],)
            ).fetchone()
        self.assertEqual(row, (UUIDS[2],))

    def test_plan_rejects_contradictory_unscoped_and_self_shapes(self) -> None:
        work, version = WorkId(UUIDS[0]), WorkVersionId(UUIDS[1])
        scope = CurationScope(work_ids=(work,), work_version_ids=(version,))
        token = SnapshotToken(sha256=sha256_digest(b"scope"))
        with self.assertRaises(CurationPlanError):
            validate_curation_plan(
                ValidatedCurationPlan(
                    plan_id=CurationPlanId(UUIDS[2]),
                    scope=scope,
                    expected_snapshot=token,
                    delete_work_ids=(WorkId(UUIDS[3]),),
                )
            )
        with self.assertRaises(CurationPlanError):
            validate_curation_plan(
                ValidatedCurationPlan(
                    plan_id=CurationPlanId(UUIDS[2]),
                    scope=scope,
                    expected_snapshot=token,
                    membership_moves=(
                        MembershipMove(
                            membership_id=MembershipId(UUIDS[4]),
                            target_work_id=work,
                            coalesce_membership_id=MembershipId(UUIDS[4]),
                        ),
                    ),
                )
            )
        with self.assertRaises(CurationPlanError):
            validate_curation_plan(
                ValidatedCurationPlan(
                    plan_id=CurationPlanId(UUIDS[2]),
                    scope=scope,
                    expected_snapshot=token,
                    reference_retargets=(
                        ReferenceRetarget(
                            reference_id=ReferenceFactId(UUIDS[5]),
                            target_work_id=work,
                            target_version_id=version,
                            downgrade_raw_text="raw",
                            downgrade_reference_json="{}",
                        ),
                    ),
                )
            )


if __name__ == "__main__":
    unittest.main()
