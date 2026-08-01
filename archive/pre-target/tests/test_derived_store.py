import hashlib
from pathlib import Path
import stat
import sys
from tempfile import TemporaryDirectory
import threading
from unittest import TestCase
from uuid import uuid4


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.errors import StorageConflictError, StorageCorruptionError, StorageError
from sciretriever.storage import DerivedArtifactReconciler, DerivedArtifactStore


class DerivedStoreTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name) / "store"
        self.root.mkdir()
        self.store = DerivedArtifactStore(self.root, chunk_size=5, max_bytes=128)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_layout_publish_replay_and_verified_read(self) -> None:
        owner = str(uuid4())
        payload = b'{"normalized":true}'
        first = self.store.publish_bytes("normalized_content", owner, payload)
        second = self.store.publish_bytes("normalized_content", owner, payload)

        self.assertTrue(first.created)
        self.assertFalse(second.created)
        self.assertEqual(first.storage_path, f"derived/normalized_content/{owner[:2]}/{owner}")
        self.assertEqual(first.sha256, hashlib.sha256(payload).hexdigest())
        self.assertEqual(self.store.read_verified(second), payload)
        self.assertEqual(self.store.find_published("normalized_content", owner), second)
        self.assertEqual(stat.S_IMODE((self.root / first.storage_path).stat().st_mode), 0o400)
        self.assertEqual(stat.S_IMODE((self.root / "derived_staging/.lock").stat().st_mode), 0o600)

    def test_owner_collision_and_bounds_fail_closed(self) -> None:
        owner = str(uuid4())
        publication = self.store.publish_bytes("source_map", owner, b"first")
        with self.assertRaises(StorageConflictError):
            self.store.publish_bytes("source_map", owner, b"second")
        self.assertEqual(self.store.read_verified(publication), b"first")
        with self.assertRaises(StorageError):
            self.store.publish_bytes("source_map", str(uuid4()), b"x" * 129)

    def test_tamper_is_detected(self) -> None:
        publication = self.store.publish_bytes("light_structure", str(uuid4()), b"light")
        target = self.root / publication.storage_path
        target.chmod(0o600)
        with self.assertRaises(StorageCorruptionError):
            self.store.read_verified(publication)

    def test_concurrent_identical_publication_converges(self) -> None:
        owner = str(uuid4())
        barrier = threading.Barrier(2)
        results = []
        failures = []

        def publish() -> None:
            try:
                barrier.wait(timeout=2)
                results.append(self.store.publish_bytes("document_package", owner, b"package"))
            except BaseException as error:
                failures.append(error)

        threads = [threading.Thread(target=publish) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=3)
        self.assertEqual(failures, [])
        self.assertEqual(sorted(result.created for result in results), [False, True])
        self.assertEqual({result.storage_path for result in results}, {results[0].storage_path})

    def test_reconciliation_recovers_checkpoint_and_preserves_unknown(self) -> None:
        owner = str(uuid4())

        def crash(name: str) -> None:
            if name == "after_staged_fsync":
                raise RuntimeError("simulated crash")

        with self.assertRaises(RuntimeError):
            self.store.publish_bytes("source_map", owner, b"recover", checkpoint=crash)
        unknown = self.root / "derived_staging/operator-note"
        unknown.write_bytes(b"keep")

        report = DerivedArtifactReconciler(self.store).reconcile_all()
        self.assertEqual(len(report.published), 1)
        self.assertEqual(report.unknown, ("derived_staging/operator-note",))
        self.assertEqual(self.store.read_verified(report.published[0]), b"recover")
        self.assertEqual(unknown.read_bytes(), b"keep")

    def test_run_lock_serializes_contenders(self) -> None:
        run_id = str(uuid4())
        first_entered = threading.Event()
        release_first = threading.Event()
        second_entered = threading.Event()

        def first() -> None:
            with self.store.run_lock(run_id):
                first_entered.set()
                release_first.wait(timeout=2)

        def second() -> None:
            first_entered.wait(timeout=2)
            with self.store.run_lock(run_id):
                second_entered.set()

        first_thread = threading.Thread(target=first)
        second_thread = threading.Thread(target=second)
        first_thread.start()
        self.assertTrue(first_entered.wait(timeout=2))
        second_thread.start()
        self.assertFalse(second_entered.wait(timeout=0.1))
        release_first.set()
        self.assertTrue(second_entered.wait(timeout=2))
        first_thread.join(timeout=2)
        second_thread.join(timeout=2)
        self.assertFalse(first_thread.is_alive())
        self.assertFalse(second_thread.is_alive())
        self.assertEqual(stat.S_IMODE((self.root / "derived_locks" / run_id).stat().st_mode), 0o600)


if __name__ == "__main__":
    import unittest

    unittest.main()
