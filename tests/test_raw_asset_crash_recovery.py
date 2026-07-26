import errno
import hashlib
from io import BytesIO
import json
from pathlib import Path
import stat
import sys
from tempfile import TemporaryDirectory
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
    initialize_catalog, create_catalog_engine,
open_catalog_engine,
)
from sciretriever.core.enums import AssetIntentState, AssetRole  # noqa: E402
from sciretriever.errors import CatalogError, DurabilityError, StorageError  # noqa: E402
from sciretriever.storage import (  # noqa: E402
    AssetAcceptanceCoordinator,
    RawAssetReconciler,
    RawAssetStore,
)
import sciretriever.storage.manager as manager_module  # noqa: E402


class InjectedCrash(BaseException):
    pass


def new_id() -> str:
    return str(uuid4())


class RecoveryEnvironment:
    def __init__(self, directory: str, label: str) -> None:
        self.base = Path(directory)
        self.catalog_path = self.base / "catalog.sqlite"
        self.storage_root = self.base / "storage"
        self.storage_root.mkdir()
        self.catalog = create_catalog_engine(self.catalog_path)
        initialize_catalog(self.catalog)
        work = IdentityResolver(self.catalog).create_or_reuse_work({"doi": f"10.1000/recovery-{label}"}).work_version
        self.work_version_id = work.id
        self._rebuild_components()

    def _rebuild_components(self) -> None:
        self.assets = AssetRepository(self.catalog)
        self.store = RawAssetStore(self.storage_root, chunk_size=7)
        self.coordinator = AssetAcceptanceCoordinator(self.assets, self.store)
        self.reconciler = RawAssetReconciler(self.store, self.assets)

    def restart(self) -> None:
        self.catalog.dispose()
        self.catalog = open_catalog_engine(self.catalog_path)
        self._rebuild_components()

    def close(self) -> None:
        self.catalog.dispose()

    def accept(self, data: bytes, intent_id: str, checkpoint=None):
        arguments = {}
        if checkpoint is not None:
            arguments["checkpoint"] = checkpoint
        return self.coordinator.accept(
            BytesIO(data),
            self.work_version_id,
            AssetRole.PRIMARY_PDF,
            "application/pdf",
            "pdf",
            {"provider": "restart-test", "intent": intent_id},
            intent_id=intent_id,
            **arguments,
        )

    def count(self, table: str) -> int:
        with self.catalog.connect() as connection:
            return connection.exec_driver_sql(
                f'SELECT count(*) FROM "{table}"'
            ).scalar_one()

    def assert_integral(self, test: TestCase) -> None:
        with self.catalog.connect() as connection:
            test.assertEqual(
                connection.exec_driver_sql("PRAGMA integrity_check").scalar_one(), "ok"
            )
            test.assertEqual(
                connection.exec_driver_sql("PRAGMA foreign_key_check").all(), []
            )
            table_names = tuple(
                connection.exec_driver_sql(
                    "SELECT name FROM sqlite_master WHERE type = 'table' "
                    "AND name NOT LIKE 'sqlite_%'"
                ).scalars()
            )
            for table in table_names:
                columns = tuple(
                    row[1]
                    for row in connection.exec_driver_sql(
                        f'PRAGMA table_info("{table}")'
                    ).all()
                )
                for column in columns:
                    blob_count = connection.exec_driver_sql(
                        f'SELECT count(*) FROM "{table}" '
                        f'WHERE typeof("{column}") = \'blob\''
                    ).scalar_one()
                    test.assertEqual(blob_count, 0, f"BLOB found in {table}.{column}")
            payloads = connection.exec_driver_sql(
                "SELECT details_json FROM diagnostic_records WHERE details_json IS NOT NULL "
                "UNION ALL SELECT provenance_json FROM asset_intents "
                "UNION ALL SELECT provenance_json FROM raw_assets"
            ).scalars()
            for payload in payloads:
                decoded = json.loads(payload)
                test.assertNotIn(str(self.base), json.dumps(decoded, sort_keys=True))


class RawAssetCrashRecoveryTests(TestCase):
    CHECKPOINTS = (
        "after_stage_fsync",
        "after_intent_commit",
        "after_target_fsync",
        "after_catalog_publish_commit",
        "after_staging_remove",
        "after_finalize_commit",
    )

    def test_every_base_exception_checkpoint_converges_after_restart(self) -> None:
        for checkpoint_name in self.CHECKPOINTS:
            with self.subTest(checkpoint=checkpoint_name), TemporaryDirectory() as directory:
                environment = RecoveryEnvironment(directory, checkpoint_name)
                intent_id = new_id()
                data = f"crash boundary {checkpoint_name}".encode("ascii")
                digest = hashlib.sha256(data).hexdigest()

                def crash(name: str, _value: object) -> None:
                    if name == checkpoint_name:
                        raise InjectedCrash(name)

                try:
                    with self.assertRaises(InjectedCrash):
                        environment.accept(data, intent_id, crash)
                    environment.restart()
                    first = environment.reconciler.reconcile_all()
                    counts = {
                        table: environment.count(table)
                        for table in (
                            "asset_intents",
                            "raw_assets",
                            "work_version_assets",
                            "diagnostic_records",
                        )
                    }
                    second = environment.reconciler.reconcile_all()

                    target = environment.storage_root / f"raw/{digest[:2]}/{digest}"
                    if checkpoint_name == "after_stage_fsync":
                        self.assertIsNone(environment.assets.get_intent(intent_id))
                        self.assertEqual(counts["asset_intents"], 0)
                        self.assertFalse(target.exists())
                        self.assertEqual(first.items, ())
                        self.assertEqual(second.items, ())
                    else:
                        intent = environment.assets.get_intent(intent_id)
                        self.assertIsNotNone(intent)
                        assert intent is not None
                        self.assertIs(intent.state, AssetIntentState.FINALIZED)
                        self.assertIsNotNone(intent.raw_asset_id)
                        self.assertEqual(counts["asset_intents"], 1)
                        self.assertEqual(counts["raw_assets"], 1)
                        self.assertEqual(counts["work_version_assets"], 1)
                        self.assertEqual(second.items[0].action, "terminal_valid")
                        raw_asset_id = intent.raw_asset_id
                        assert raw_asset_id is not None
                        raw = environment.assets.get_raw_asset(raw_asset_id)
                        self.assertIsNotNone(raw)
                        self.assertEqual(raw.sha256, digest)
                        links = environment.assets.get_work_version_assets(environment.work_version_id)
                        self.assertEqual(len(links), 1)
                        self.assertEqual(links[0].raw_asset_id, intent.raw_asset_id)
                        self.assertIs(links[0].asset_role, AssetRole.PRIMARY_PDF)
                        self.assertEqual(target.read_bytes(), data)
                        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o400)
                    self.assertEqual(environment.store.enumerate_staging()[0], ())
                    self.assertEqual(
                        {
                            table: environment.count(table)
                            for table in counts
                        },
                        counts,
                    )
                    environment.assert_integral(self)
                finally:
                    environment.close()

    def test_realistic_boundary_failures_recover_after_restart(self) -> None:
        cases = ("link", "target_fsync", "catalog_transaction", "cleanup_fsync")
        for label in cases:
            with self.subTest(boundary=label), TemporaryDirectory() as directory:
                environment = RecoveryEnvironment(directory, label)
                intent_id = new_id()
                data = f"boundary failure {label}".encode("ascii")
                real_fsync = environment.store._fsync

                try:
                    if label == "link":
                        injected = OSError(errno.EIO, "injected link failure")
                        context = patch.object(manager_module.os, "link", side_effect=injected)
                        expected = StorageError
                    elif label == "target_fsync":
                        def fail_target(descriptor: int, subject: str) -> None:
                            if subject == "published asset":
                                raise DurabilityError("injected target fsync failure")
                            real_fsync(descriptor, subject)

                        context = patch.object(environment.store, "_fsync", fail_target)
                        expected = DurabilityError
                    elif label == "catalog_transaction":
                        context = patch.object(
                            environment.assets,
                "register_verified_published_intent",
                            side_effect=CatalogError("injected catalog transaction failure"),
                        )
                        expected = CatalogError
                    else:
                        def fail_cleanup(descriptor: int, subject: str) -> None:
                            if subject == "staging directory after removal":
                                raise DurabilityError("injected cleanup fsync failure")
                            real_fsync(descriptor, subject)

                        context = patch.object(environment.store, "_fsync", fail_cleanup)
                        expected = DurabilityError

                    with context, self.assertRaises(expected):
                        environment.accept(data, intent_id)
                    environment.restart()
                    environment.reconciler.reconcile_all()
                    diagnostic_count = environment.count("diagnostic_records")
                    environment.reconciler.reconcile_all()

                    intent = environment.assets.get_intent(intent_id)
                    self.assertIsNotNone(intent)
                    assert intent is not None
                    self.assertIs(intent.state, AssetIntentState.FINALIZED)
                    self.assertEqual(environment.count("raw_assets"), 1)
                    self.assertEqual(environment.count("work_version_assets"), 1)
                    self.assertEqual(
                        environment.count("diagnostic_records"),
                        diagnostic_count,
                    )
                    environment.assert_integral(self)
                finally:
                    environment.close()

    def test_corrupt_preexisting_target_fails_closed_across_restart(self) -> None:
        with TemporaryDirectory() as directory:
            environment = RecoveryEnvironment(directory, "corrupt-target")
            data = b"expected immutable evidence"
            digest = hashlib.sha256(data).hexdigest()
            target = environment.storage_root / f"raw/{digest[:2]}/{digest}"
            target.parent.mkdir(mode=0o700)
            target.write_bytes(b"corrupt immutable raw")
            target.chmod(0o400)
            before = target.stat()
            intent_id = new_id()
            try:
                with self.assertRaises(StorageError):
                    environment.accept(data, intent_id)
                environment.restart()
                first = environment.reconciler.reconcile_all()
                diagnostic_count = environment.count("diagnostic_records")
                second = environment.reconciler.reconcile_all()

                after = target.stat()
                self.assertEqual((after.st_dev, after.st_ino), (before.st_dev, before.st_ino))
                self.assertEqual(target.read_bytes(), b"corrupt immutable raw")
                self.assertEqual(environment.count("raw_assets"), 0)
                self.assertIs(
                    environment.assets.get_intent(intent_id).state,
                    AssetIntentState.ABANDONED,
                )
                self.assertEqual(first.items[0].action, "abandoned_corrupt_target")
                self.assertEqual(second.items[0].action, "terminal_abandoned")
                self.assertEqual(environment.count("diagnostic_records"), diagnostic_count)
                environment.assert_integral(self)
            finally:
                environment.close()

    def test_pending_correct_target_without_catalog_row_is_registered(self) -> None:
        with TemporaryDirectory() as directory:
            environment = RecoveryEnvironment(directory, "pending-target")
            data = b"preexisting correct target"
            intent_id = new_id()
            staged = environment.store.stage(BytesIO(data), intent_id=intent_id)
            intent = environment.assets.create_intent(
                intent_id,
                environment.work_version_id,
                AssetRole.PRIMARY_PDF,
                staged.sha256,
                "application/pdf",
                "pdf",
                staged.byte_size,
                {"provider": "pending-target"},
            )
            environment.store.publish(staged)
            environment.store.remove_staged(staged)
            try:
                self.assertIsNone(environment.assets.get_raw_asset_by_sha256(staged.sha256))
                environment.restart()
                first = environment.reconciler.reconcile_all()
                diagnostic_count = environment.count("diagnostic_records")
                second = environment.reconciler.reconcile_all()

                recovered = environment.assets.get_intent(intent.id)
                self.assertIs(recovered.state, AssetIntentState.FINALIZED)
                self.assertEqual(first.items[0].action, "registered_target_finalized")
                self.assertEqual(second.items[0].action, "terminal_valid")
                self.assertEqual(environment.count("raw_assets"), 1)
                self.assertEqual(environment.count("work_version_assets"), 1)
                self.assertEqual(environment.count("diagnostic_records"), diagnostic_count)
                environment.assert_integral(self)
            finally:
                environment.close()

    def test_published_missing_target_stays_published_with_one_failure(self) -> None:
        with TemporaryDirectory() as directory:
            environment = RecoveryEnvironment(directory, "published-missing")
            data = b"published target later missing"
            intent_id = new_id()

            def crash(name: str, _value: object) -> None:
                if name == "after_staging_remove":
                    raise InjectedCrash(name)

            try:
                with self.assertRaises(InjectedCrash):
                    environment.accept(data, intent_id, crash)
                intent = environment.assets.get_intent(intent_id)
                target = environment.storage_root / intent.storage_path
                target.unlink()
                environment.restart()
                first = environment.reconciler.reconcile_all()
                diagnostic_count = environment.count("diagnostic_records")
                second = environment.reconciler.reconcile_all()

                self.assertIs(
                    environment.assets.get_intent(intent_id).state,
                    AssetIntentState.PUBLISHED,
                )
                self.assertEqual(first.items[0].action, "retained_missing_target")
                self.assertEqual(second.items[0].action, "retained_missing_target")
                self.assertEqual(len(first.items[0].failures), len(second.items[0].failures))
                self.assertEqual(environment.count("diagnostic_records"), 2)
                self.assertEqual(
                    environment.count("diagnostic_records"),
                    diagnostic_count + 1,
                )
                environment.assert_integral(self)
            finally:
                environment.close()

    def test_finalized_missing_and_corrupt_targets_record_idempotent_failures(self) -> None:
        for condition in ("missing", "corrupt"):
            with self.subTest(condition=condition), TemporaryDirectory() as directory:
                environment = RecoveryEnvironment(directory, f"finalized-{condition}")
                data = f"finalized {condition}".encode("ascii")
                intent_id = new_id()
                try:
                    result = environment.accept(data, intent_id)
                    target = environment.storage_root / result.publication.storage_path
                    if condition == "missing":
                        target.unlink()
                        expected_bytes = None
                        expected_inode = None
                    else:
                        target.chmod(0o600)
                        target.write_bytes(b"corrupt finalized raw")
                        target.chmod(0o400)
                        expected_bytes = target.read_bytes()
                        expected_inode = target.stat().st_ino
                    environment.restart()
                    first = environment.reconciler.reconcile_all()
                    diagnostic_count = environment.count("diagnostic_records")
                    second = environment.reconciler.reconcile_all()

                    self.assertIs(
                        environment.assets.get_intent(intent_id).state,
                        AssetIntentState.FINALIZED,
                    )
                    self.assertEqual(first.items[0].action, "retained_integrity_failure")
                    self.assertEqual(second.items[0].action, "retained_integrity_failure")
                    self.assertEqual(len(first.items[0].failures), len(second.items[0].failures))
                    self.assertEqual(environment.count("diagnostic_records"), 2)
                    self.assertEqual(
                        environment.count("diagnostic_records"),
                        diagnostic_count + 1,
                    )
                    if condition == "missing":
                        self.assertFalse(target.exists())
                    else:
                        self.assertEqual(target.stat().st_ino, expected_inode)
                        self.assertEqual(target.read_bytes(), expected_bytes)
                    environment.assert_integral(self)
                finally:
                    environment.close()

    def test_restart_removes_recognized_orphan_and_retains_unknown_and_symlink(self) -> None:
        with TemporaryDirectory() as directory:
            environment = RecoveryEnvironment(directory, "orphans")
            orphan = environment.store.stage(BytesIO(b"recognized orphan"), intent_id=new_id())
            unknown = environment.storage_root / "staging/operator.note"
            unknown.write_bytes(b"retain unknown")
            link = environment.storage_root / f"staging/{new_id()}.part"
            link.symlink_to(unknown)
            try:
                environment.restart()
                first = environment.reconciler.reconcile_all()
                second = environment.reconciler.reconcile_all()

                self.assertEqual(first.staging_orphans, (orphan.temporary_path,))
                self.assertEqual(first.removed_staging_orphans, (orphan.temporary_path,))
                self.assertEqual(second.staging_orphans, ())
                self.assertFalse((environment.storage_root / orphan.temporary_path).exists())
                self.assertEqual(unknown.read_bytes(), b"retain unknown")
                self.assertTrue(link.is_symlink())
                self.assertIn("staging/operator.note", first.unknown_staging)
                self.assertIn(f"staging/{link.name}", first.unknown_staging)
                environment.assert_integral(self)
            finally:
                environment.close()


if __name__ == "__main__":
    import unittest

    unittest.main()
