import hashlib
import importlib
from io import BytesIO
import os
from pathlib import Path
import stat
import sys
from tempfile import TemporaryDirectory
import threading
import time
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import (  # noqa: E402
    AssetRepository,
    IdentityResolver,
    JobRepository, initialize_catalog, create_catalog_engine,
open_catalog_engine,
)
from sciretriever.core.enums import AssetIntentState, AssetRole  # noqa: E402
from sciretriever.errors import (  # noqa: E402
    DurabilityError,
    StorageCorruptionError,
)
from sciretriever.storage.manager import RawAssetStore  # noqa: E402
from sciretriever.storage.records import StagedAsset  # noqa: E402
import sciretriever.storage.manager as manager_module  # noqa: E402

reconciler_api = importlib.import_module("sciretriever.storage.reconciler")
RawAssetReconciler = reconciler_api.RawAssetReconciler
ReconciliationItem = reconciler_api.ReconciliationItem
ReconciliationReport = reconciler_api.ReconciliationReport


def new_id() -> str:
    return str(uuid4())


class ReconciliationEnvironment:
    def __init__(self, directory: str) -> None:
        self.base = Path(directory)
        self.storage_root = self.base / "store"
        self.storage_root.mkdir()
        self.catalog_path = self.base / "catalog.sqlite"
        self.catalog = create_catalog_engine(self.catalog_path)
        initialize_catalog(self.catalog)
        self.store = RawAssetStore(self.storage_root)
        self.assets = AssetRepository(self.catalog)
        self.reconciler = RawAssetReconciler(self.store, self.assets)
        work = IdentityResolver(self.catalog).create_or_reuse_work({"doi": f"10.1000/{new_id()}"}).work_version
        job = JobRepository(self.catalog).attach_or_create_job(
            work.id, AssetRole.PRIMARY_PDF
        )
        self.work_version_id = work.id
        self.job_id = job.id

    def close(self) -> None:
        self.catalog.dispose()

    def create_case(
        self,
        state: AssetIntentState,
        staged_presence: str,
        target_presence: str,
        *,
        data: bytes = b"raw reconciliation evidence",
    ):
        intent_id = new_id()
        sha256 = hashlib.sha256(data).hexdigest()
        intent = self.assets.create_intent(
            intent_id,
            self.work_version_id,
            self.job_id,
            AssetRole.PRIMARY_PDF,
            sha256,
            "application/pdf",
            "pdf",
            len(data),
            {"provider": "test"},
        )
        staged = self.store.stage(BytesIO(data), intent_id=intent_id)
        target = self.storage_root / intent.storage_path

        if target_presence == "valid":
            self.store.publish(staged)
        elif target_presence == "corrupt":
            target.parent.mkdir(mode=0o700)
            target.write_bytes(b"corrupt target evidence")
            target.chmod(0o400)

        if staged_presence != "valid":
            self.store.remove_staged(staged)
            if staged_presence == "corrupt":
                staged_path = self.storage_root / staged.temporary_path
                staged_path.write_bytes(b"corrupt staged evidence")
                staged_path.chmod(0o400)

        if state in {AssetIntentState.PUBLISHED, AssetIntentState.FINALIZED}:
            intent = self.assets.register_verified_published_intent(intent.id)
        if state is AssetIntentState.FINALIZED:
            intent = self.assets.finalize_intent(intent.id)
        elif state is AssetIntentState.ABANDONED:
            intent = self.assets.abandon_pending_intent(
                intent.id, "test_abandonment", "test abandonment"
            )
        return intent, staged, target

    def count(self, table: str) -> int:
        with self.catalog.connect() as connection:
            return connection.exec_driver_sql(
                f'SELECT count(*) FROM "{table}"'
            ).scalar_one()


class RawAssetReconcilerMatrixTests(TestCase):
    def run_case(
        self,
        state: AssetIntentState,
        staged_presence: str,
        target_presence: str,
    ) -> None:
        with TemporaryDirectory() as directory:
            environment = ReconciliationEnvironment(directory)
            self.addCleanup(environment.close)
            intent, staged, target = environment.create_case(
                state, staged_presence, target_presence
            )
            staged_path = environment.storage_root / staged.temporary_path
            staged_before = os.path.lexists(staged_path)
            target_before = os.path.lexists(target)
            target_inode = target.lstat().st_ino if target_before else None
            target_bytes = target.read_bytes() if target_before else None
            failures_before = environment.count("failures")

            report = environment.reconciler.reconcile_all()

            self.assertIsInstance(report, ReconciliationReport)
            self.assertEqual(len(report.items), 1)
            item = report.items[0]
            self.assertIsInstance(item, ReconciliationItem)
            self.assertEqual(item.intent_id, intent.id)
            self.assertIs(item.before_state, state)
            after = environment.assets.get_intent(intent.id)
            self.assertIs(item.after_state, after.state)

            if state is AssetIntentState.PENDING:
                if target_presence == "corrupt":
                    expected_state = AssetIntentState.ABANDONED
                    expected_stage = staged_before
                    expected_target = True
                    expected_new_failures = 1
                elif target_presence == "valid":
                    expected_state = AssetIntentState.FINALIZED
                    expected_stage = staged_presence == "corrupt"
                    expected_target = True
                    expected_new_failures = int(staged_presence == "corrupt")
                elif staged_presence == "valid":
                    expected_state = AssetIntentState.FINALIZED
                    expected_stage = False
                    expected_target = True
                    expected_new_failures = 0
                else:
                    expected_state = AssetIntentState.ABANDONED
                    expected_stage = staged_presence == "corrupt"
                    expected_target = False
                    expected_new_failures = 1
            elif state is AssetIntentState.PUBLISHED:
                if target_presence == "corrupt":
                    expected_state = AssetIntentState.PUBLISHED
                    expected_stage = staged_before
                    expected_target = True
                    expected_new_failures = 1
                elif target_presence == "valid":
                    expected_state = AssetIntentState.FINALIZED
                    expected_stage = staged_presence == "corrupt"
                    expected_target = True
                    expected_new_failures = int(staged_presence == "corrupt")
                elif staged_presence == "valid":
                    expected_state = AssetIntentState.FINALIZED
                    expected_stage = False
                    expected_target = True
                    expected_new_failures = 0
                else:
                    expected_state = AssetIntentState.PUBLISHED
                    expected_stage = staged_presence == "corrupt"
                    expected_target = False
                    expected_new_failures = 2 if staged_presence == "corrupt" else 1
            else:
                expected_state = AssetIntentState.FINALIZED
                if target_presence == "valid":
                    expected_stage = staged_presence == "corrupt"
                    expected_new_failures = int(staged_presence == "corrupt")
                else:
                    expected_stage = staged_before
                    expected_new_failures = 1
                expected_target = target_before

            self.assertIs(after.state, expected_state)
            self.assertEqual(os.path.lexists(staged_path), expected_stage)
            self.assertEqual(os.path.lexists(target), expected_target)
            self.assertEqual(
                environment.count("failures") - failures_before,
                expected_new_failures,
            )
            self.assertEqual(len(item.failures), expected_new_failures)
            if target_presence == "corrupt":
                self.assertEqual(target.lstat().st_ino, target_inode)
                self.assertEqual(target.read_bytes(), target_bytes)

    def test_pending_published_and_finalized_presence_matrix(self) -> None:
        for state in (
            AssetIntentState.PENDING,
            AssetIntentState.PUBLISHED,
            AssetIntentState.FINALIZED,
        ):
            for staged in ("absent", "valid", "corrupt"):
                for target in ("absent", "valid", "corrupt"):
                    with self.subTest(state=state.value, staged=staged, target=target):
                        self.run_case(state, staged, target)

    def test_abandoned_intents_never_publish_or_delete_files(self) -> None:
        for staged, target in (
            ("absent", "absent"),
            ("valid", "valid"),
            ("corrupt", "corrupt"),
        ):
            with self.subTest(staged=staged, target=target):
                with TemporaryDirectory() as directory:
                    environment = ReconciliationEnvironment(directory)
                    intent, staged_asset, target_path = environment.create_case(
                        AssetIntentState.ABANDONED, staged, target
                    )
                    self.addCleanup(environment.close)
                    staged_path = environment.storage_root / staged_asset.temporary_path
                    before = (
                        os.path.lexists(staged_path),
                        os.path.lexists(target_path),
                        environment.count("failures"),
                        environment.count("events"),
                    )

                    report = environment.reconciler.reconcile_all()

                    self.assertEqual(report.items[0].action, "terminal_abandoned")
                    self.assertIs(
                        environment.assets.get_intent(intent.id).state,
                        AssetIntentState.ABANDONED,
                    )
                    self.assertEqual(
                        (
                            os.path.lexists(staged_path),
                            os.path.lexists(target_path),
                            environment.count("failures"),
                            environment.count("events"),
                        ),
                        before,
                    )


class RawAssetReconcilerSafetyTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.environment = ReconciliationEnvironment(self.temporary.name)
        self.addCleanup(self.environment.close)

    def test_presence_is_absent_only_for_file_not_found(self) -> None:
        data = b"presence evidence"
        intent_id = new_id()
        sha256 = hashlib.sha256(data).hexdigest()
        staged = StagedAsset(
            intent_id, f"staging/{intent_id}.part", sha256, len(data)
        )
        self.assertFalse(self.environment.store.staged_exists(staged))
        self.assertFalse(
            self.environment.store.published_exists(sha256, len(data))
        )

        staged_path = self.environment.storage_root / staged.temporary_path
        external = Path(self.temporary.name) / "external"
        external.write_bytes(data)
        staged_path.symlink_to(external)
        with self.assertRaises(StorageCorruptionError):
            self.environment.store.staged_exists(staged)
        staged_path.unlink()
        staged_path.mkdir()
        with self.assertRaises(StorageCorruptionError):
            self.environment.store.staged_exists(staged)
        staged_path.rmdir()

        shard = self.environment.storage_root / "raw" / sha256[:2]
        shard.mkdir(mode=0o700)
        target = shard / sha256
        target.symlink_to(external)
        with self.assertRaises(StorageCorruptionError):
            self.environment.store.published_exists(sha256, len(data))
        target.unlink()
        target.mkdir()
        with self.assertRaises(StorageCorruptionError):
            self.environment.store.published_exists(sha256, len(data))

    def test_correct_preexisting_target_without_raw_row_is_registered(self) -> None:
        intent, staged, target = self.environment.create_case(
            AssetIntentState.PENDING, "absent", "valid"
        )
        self.assertIsNone(
            self.environment.assets.get_raw_asset_by_sha256(intent.expected_sha256)
        )

        report = self.environment.reconciler.reconcile_all()

        reconciled = self.environment.assets.get_intent(intent.id)
        self.assertIs(reconciled.state, AssetIntentState.FINALIZED)
        self.assertIsNotNone(reconciled.raw_asset_id)
        self.assertTrue(target.exists())
        self.assertFalse(
            (self.environment.storage_root / staged.temporary_path).exists()
        )
        self.assertEqual(report.items[0].failures, ())

    def test_target_symlink_is_retained_and_pending_intent_is_abandoned(self) -> None:
        intent, staged, target = self.environment.create_case(
            AssetIntentState.PENDING, "valid", "absent"
        )
        target.parent.mkdir(mode=0o700)
        outside = Path(self.temporary.name) / "outside-target"
        outside.write_bytes(b"outside")
        target.symlink_to(outside)

        report = self.environment.reconciler.reconcile_all()

        self.assertTrue(target.is_symlink())
        self.assertEqual(outside.read_bytes(), b"outside")
        self.assertTrue(
            (self.environment.storage_root / staged.temporary_path).exists()
        )
        self.assertIs(
            self.environment.assets.get_intent(intent.id).state,
            AssetIntentState.ABANDONED,
        )
        self.assertEqual(report.items[0].action, "abandoned_corrupt_target")

    def test_writable_target_is_retained_and_pending_intent_is_abandoned(self) -> None:
        intent, staged, target = self.environment.create_case(
            AssetIntentState.PENDING, "absent", "valid"
        )
        target.chmod(0o600)
        before = target.stat()
        content = target.read_bytes()

        first = self.environment.reconciler.reconcile_all()
        counts = (
            self.environment.count("events"),
            self.environment.count("failures"),
        )
        second = self.environment.reconciler.reconcile_all()

        after = target.stat()
        self.assertEqual((after.st_dev, after.st_ino), (before.st_dev, before.st_ino))
        self.assertEqual(target.read_bytes(), content)
        self.assertEqual(stat.S_IMODE(after.st_mode), 0o600)
        reconciled = self.environment.assets.get_intent(intent.id)
        self.assertIs(reconciled.state, AssetIntentState.ABANDONED)
        self.assertIsNone(reconciled.raw_asset_id)
        self.assertEqual(self.environment.count("raw_assets"), 0)
        self.assertEqual(self.environment.count("work_version_assets"), 0)
        self.assertEqual(first.items[0].action, "abandoned_corrupt_target")
        self.assertEqual(second.items[0].action, "terminal_abandoned")
        self.assertEqual(
            (
                self.environment.count("events"),
                self.environment.count("failures"),
            ),
            counts,
        )
        self.assertFalse(
            (self.environment.storage_root / staged.temporary_path).exists()
        )

    def test_orphans_are_removed_but_unknown_and_symlinks_are_retained(self) -> None:
        orphan = self.environment.store.stage(
            BytesIO(b"unowned staged bytes"), intent_id=new_id()
        )
        unknown_file = self.environment.storage_root / "staging" / "operator.note"
        unknown_file.write_bytes(b"keep")
        unknown_directory = self.environment.storage_root / "staging" / "manual"
        unknown_directory.mkdir()
        link_id = new_id()
        unknown_link = (
            self.environment.storage_root / "staging" / f"{link_id}.part"
        )
        unknown_link.symlink_to(unknown_file)

        report = self.environment.reconciler.reconcile_all()

        self.assertEqual(report.staging_orphans, (orphan.temporary_path,))
        self.assertEqual(report.removed_staging_orphans, (orphan.temporary_path,))
        self.assertFalse(
            (self.environment.storage_root / orphan.temporary_path).exists()
        )
        self.assertEqual(
            report.unknown_staging,
            tuple(
                sorted(
                    (
                        f"staging/{link_id}.part",
                        "staging/manual",
                        "staging/operator.note",
                    )
                )
            ),
        )
        self.assertEqual(unknown_file.read_bytes(), b"keep")
        self.assertTrue(unknown_directory.is_dir())
        self.assertTrue(unknown_link.is_symlink())

    def test_orphan_durability_failure_is_not_suppressed(self) -> None:
        orphan = self.environment.store.stage(
            BytesIO(b"orphan durability"), intent_id=new_id()
        )
        with patch.object(manager_module.os, "fsync", side_effect=OSError("fsync failed")):
            with self.assertRaises(DurabilityError):
                self.environment.reconciler.reconcile_all()
        self.assertFalse(
            (self.environment.storage_root / orphan.temporary_path).exists()
        )

    def test_raw_metadata_mismatch_is_durable_and_blocks_file_cleanup(self) -> None:
        intent, staged, target = self.environment.create_case(
            AssetIntentState.PUBLISHED, "valid", "valid"
        )
        self.assertIsNotNone(intent.raw_asset_id)
        raw_asset_id = intent.raw_asset_id
        assert raw_asset_id is not None
        with self.environment.catalog.transaction() as connection:
            connection.exec_driver_sql("DROP TRIGGER trg_raw_assets_immutable_update")
            connection.exec_driver_sql(
                "UPDATE raw_assets SET media_type = ? WHERE id = ?",
                ("application/octet-stream", raw_asset_id),
            )
        before = self.environment.assets.get_raw_asset(raw_asset_id)

        first = self.environment.reconciler.reconcile_all()
        counts = (
            self.environment.count("failures"),
            self.environment.count("events"),
        )
        second = self.environment.reconciler.reconcile_all()

        self.assertEqual(first.items[0].action, "retained_catalog_mismatch")
        self.assertEqual(second.items[0].action, "retained_catalog_mismatch")
        self.assertEqual(first.items[0].failures, second.items[0].failures)
        self.assertEqual(
            (
                self.environment.count("failures"),
                self.environment.count("events"),
            ),
            counts,
        )
        self.assertEqual(
            self.environment.assets.get_raw_asset(raw_asset_id), before
        )
        self.assertIs(
            self.environment.assets.get_intent(intent.id).state,
            AssetIntentState.PUBLISHED,
        )
        self.assertTrue(target.exists())
        self.assertTrue(
            (self.environment.storage_root / staged.temporary_path).exists()
        )

    def test_repeated_reconciliation_has_stable_reports_and_no_duplicate_rows(self) -> None:
        intent, _, _ = self.environment.create_case(
            AssetIntentState.PENDING, "corrupt", "valid"
        )
        self.environment.reconciler.reconcile_all()
        counts = (
            self.environment.count("failures"),
            self.environment.count("events"),
            self.environment.count("raw_assets"),
            self.environment.count("work_version_assets"),
        )

        second = self.environment.reconciler.reconcile_all()
        third = self.environment.reconciler.reconcile_all()

        self.assertEqual(second, third)
        self.assertEqual(
            (
                self.environment.count("failures"),
                self.environment.count("events"),
                self.environment.count("raw_assets"),
                self.environment.count("work_version_assets"),
            ),
            counts,
        )
        self.assertIs(
            self.environment.assets.get_intent(intent.id).state,
            AssetIntentState.FINALIZED,
        )

    def test_restart_recovers_published_intent_from_staged_evidence(self) -> None:
        intent, staged, target = self.environment.create_case(
            AssetIntentState.PUBLISHED, "valid", "absent"
        )
        self.environment.catalog.dispose()
        reopened = open_catalog_engine(self.environment.catalog_path)
        self.environment.catalog = reopened
        self.environment.assets = AssetRepository(reopened)
        restarted_store = RawAssetStore(self.environment.storage_root)
        restarted = RawAssetReconciler(restarted_store, self.environment.assets)

        restarted.reconcile_all()

        self.assertIs(
            self.environment.assets.get_intent(intent.id).state,
            AssetIntentState.FINALIZED,
        )
        self.assertTrue(target.exists())
        self.assertFalse(
            (self.environment.storage_root / staged.temporary_path).exists()
        )

    def test_exclusive_reconciliation_waits_for_coordinator_shared_lock(self) -> None:
        attempted = threading.Event()
        completed = threading.Event()
        failures: list[BaseException] = []

        def reconcile() -> None:
            attempted.set()
            try:
                self.environment.reconciler.reconcile_all()
            except BaseException as error:
                failures.append(error)
            finally:
                completed.set()

        with self.environment.store.lock():
            thread = threading.Thread(target=reconcile)
            thread.start()
            self.assertTrue(attempted.wait(timeout=1))
            time.sleep(0.05)
            self.assertFalse(completed.is_set())
        thread.join(timeout=2)
        self.assertTrue(completed.is_set())
        self.assertEqual(failures, [])

    def test_two_concurrent_reconcilers_converge_and_catalog_is_integral(self) -> None:
        intent, staged, target = self.environment.create_case(
            AssetIntentState.PENDING, "valid", "absent"
        )
        barrier = threading.Barrier(2)
        reports: list[ReconciliationReport] = []
        failures: list[BaseException] = []

        def reconcile() -> None:
            try:
                barrier.wait(timeout=2)
                reports.append(self.environment.reconciler.reconcile_all())
            except BaseException as error:
                failures.append(error)

        threads = [threading.Thread(target=reconcile) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=3)

        self.assertEqual(failures, [])
        self.assertEqual(len(reports), 2)
        self.assertIs(
            self.environment.assets.get_intent(intent.id).state,
            AssetIntentState.FINALIZED,
        )
        self.assertTrue(target.exists())
        self.assertFalse(
            (self.environment.storage_root / staged.temporary_path).exists()
        )
        self.assertEqual(self.environment.count("raw_assets"), 1)
        self.assertEqual(self.environment.count("work_version_assets"), 1)
        with self.environment.catalog.connect() as connection:
            self.assertEqual(
                connection.exec_driver_sql("PRAGMA integrity_check").scalar_one(),
                "ok",
            )
            self.assertEqual(
                connection.exec_driver_sql("PRAGMA foreign_key_check").all(), []
            )


if __name__ == "__main__":
    import unittest

    unittest.main()
