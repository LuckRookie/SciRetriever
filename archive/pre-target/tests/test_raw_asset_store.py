import errno
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

storage = importlib.import_module("sciretriever.storage")
manager = importlib.import_module("sciretriever.storage.manager")
records = importlib.import_module("sciretriever.storage.records")
errors = importlib.import_module("sciretriever.errors")

PublicationResult = storage.PublicationResult
RawAssetStore = storage.RawAssetStore
StagedAsset = storage.StagedAsset


class CountingStream:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self._offset = 0
        self.bytes_returned = 0
        self.read_calls = 0

    def read(self, size: int = -1) -> bytes:
        self.read_calls += 1
        if self._offset >= len(self._data):
            return b""
        end = len(self._data) if size < 0 else self._offset + size
        chunk = self._data[self._offset:end]
        self._offset += len(chunk)
        self.bytes_returned += len(chunk)
        return chunk


class FailingStream:
    def __init__(self, first: bytes = b"") -> None:
        self._first = first

    def read(self, size: int = -1) -> bytes:
        if self._first:
            first, self._first = self._first, b""
            return first
        raise OSError("stream failed")


class NonBytesStream:
    def read(self, size: int = -1) -> str:
        return "text"


class RawAssetStoreTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name) / "store"
        self.root.mkdir()
        self.store = RawAssetStore(self.root, chunk_size=7)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def intent(self) -> str:
        return str(uuid4())

    def stage(self, data: bytes = b"raw evidence") -> StagedAsset:
        return self.store.stage(BytesIO(data), intent_id=self.intent())

    def raw_path(self, asset: StagedAsset) -> Path:
        return self.root / "raw" / asset.sha256[:2] / asset.sha256

    def test_layout_modes_records_and_exact_paths(self) -> None:
        self.assertEqual(stat.S_IMODE(self.root.joinpath("staging").stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.root.joinpath("raw").stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.root.joinpath("staging/.lock").stat().st_mode), 0o600)

        intent_id = self.intent()
        data = b"abcdef" * 5
        staged = self.store.stage(BytesIO(data), intent_id=intent_id)
        self.assertEqual(staged.temporary_path, f"staging/{intent_id}.part")
        self.assertEqual(staged.sha256, hashlib.sha256(data).hexdigest())
        self.assertEqual(staged.byte_size, len(data))
        self.assertFalse(hasattr(staged, "__dict__"))
        self.assertEqual(stat.S_IMODE((self.root / staged.temporary_path).stat().st_mode), 0o400)

        published = self.store.publish(staged)
        expected = f"raw/{staged.sha256[:2]}/{staged.sha256}"
        self.assertEqual(published, PublicationResult(expected, staged.sha256, len(data), True))
        self.assertEqual(stat.S_IMODE((self.root / published.storage_path).stat().st_mode), 0o400)
        self.assertFalse(hasattr(published, "__dict__"))

    def test_stage_hashes_in_one_pass_without_seek(self) -> None:
        data = bytes(range(64)) * 3
        stream = CountingStream(data)
        staged = self.store.stage(stream, intent_id=self.intent())

        self.assertEqual(stream.bytes_returned, len(data))
        self.assertEqual(staged.sha256, hashlib.sha256(data).hexdigest())
        self.assertEqual((self.root / staged.temporary_path).read_bytes(), data)

    def test_empty_nonbytes_and_read_failures_clean_only_owned_file(self) -> None:
        unknown = self.root / "staging" / "operator-note"
        unknown.write_bytes(b"keep")
        completed = self.stage(b"complete")

        cases = (BytesIO(b""), NonBytesStream(), FailingStream(b"partial"))
        for stream in cases:
            with self.subTest(stream=type(stream).__name__):
                intent_id = self.intent()
                with self.assertRaises(errors.StorageError):
                    self.store.stage(stream, intent_id=intent_id)
                self.assertFalse((self.root / f"staging/{intent_id}.part").exists())

        self.assertEqual(unknown.read_bytes(), b"keep")
        self.assertEqual((self.root / completed.temporary_path).read_bytes(), b"complete")

    def test_stage_fsync_failure_is_typed_and_cleans_incomplete_file(self) -> None:
        intent_id = self.intent()
        with patch.object(manager.os, "fsync", side_effect=[OSError("fsync"), None]):
            with self.assertRaises(errors.DurabilityError):
                self.store.stage(BytesIO(b"content"), intent_id=intent_id)

        self.assertFalse((self.root / f"staging/{intent_id}.part").exists())

    def test_verify_and_remove_staged_are_exact_and_durable(self) -> None:
        staged = self.stage()
        self.assertIs(self.store.verify_staged(staged), staged)
        self.store.remove_staged(staged)
        self.assertFalse((self.root / staged.temporary_path).exists())
        with self.assertRaises(errors.StorageCorruptionError):
            self.store.verify_staged(staged)

    def test_publish_existing_correct_target_returns_false_and_keeps_stage(self) -> None:
        first = self.stage(b"same bytes")
        created = self.store.publish(first)
        second = self.store.stage(BytesIO(b"same bytes"), intent_id=self.intent())

        reused = self.store.publish(second)

        self.assertTrue(created.created)
        self.assertFalse(reused.created)
        self.assertTrue((self.root / second.temporary_path).exists())
        self.assertEqual(self.store.verify_published(reused), reused)
        self.assertFalse(self.store.verify_published(second.sha256, second.byte_size).created)

    def test_read_verified_is_bounded_and_checks_record_identity(self) -> None:
        payload = b"bounded raw bytes"
        staged = self.stage(payload)
        publication = self.store.publish(staged)
        self.store.remove_staged(staged)

        self.assertEqual(
            self.store.read_verified(
                publication.storage_path, publication.sha256, publication.byte_size, len(payload)
            ),
            payload,
        )
        with self.assertRaises(errors.StorageError):
            self.store.read_verified(
                publication.storage_path, publication.sha256, publication.byte_size, len(payload) - 1
            )
        with self.assertRaises(errors.StoragePathError):
            self.store.read_verified(
                f"raw/ff/{publication.sha256}", publication.sha256, publication.byte_size, len(payload)
            )

    def test_explicit_eexist_verifies_existing_target(self) -> None:
        first = self.stage(b"same")
        self.store.publish(first)
        second = self.store.stage(BytesIO(b"same"), intent_id=self.intent())

        with patch.object(manager.os, "link", side_effect=FileExistsError(errno.EEXIST, "exists")):
            result = self.store.publish(second)

        self.assertFalse(result.created)

    def test_corrupt_existing_target_is_never_overwritten_or_removed(self) -> None:
        staged = self.stage(b"expected content")
        target = self.raw_path(staged)
        target.parent.mkdir(mode=0o700)
        target.write_bytes(b"corrupt content!")
        target.chmod(0o400)
        before = target.stat()

        with self.assertRaises(errors.StorageCorruptionError):
            self.store.publish(staged)

        after = target.stat()
        self.assertEqual((after.st_dev, after.st_ino), (before.st_dev, before.st_ino))
        self.assertEqual(target.read_bytes(), b"corrupt content!")
        self.assertTrue((self.root / staged.temporary_path).exists())

    def test_correct_writable_existing_target_is_retained_and_rejected(self) -> None:
        for mode in (0o600, 0o644):
            with self.subTest(mode=oct(mode)):
                data = f"correct writable target {mode:o}".encode("ascii")
                staged = self.stage(data)
                target = self.raw_path(staged)
                target.parent.mkdir(mode=0o700, exist_ok=True)
                target.write_bytes(data)
                target.chmod(mode)
                before = target.stat()

                with self.assertRaises(errors.StorageCorruptionError):
                    self.store.publish(staged)

                after = target.stat()
                self.assertEqual(
                    (after.st_dev, after.st_ino), (before.st_dev, before.st_ino)
                )
                self.assertEqual(target.read_bytes(), data)
                self.assertEqual(stat.S_IMODE(after.st_mode), mode)
                self.assertTrue((self.root / staged.temporary_path).exists())

    def test_correct_writable_staged_entry_is_retained_and_rejected(self) -> None:
        staged = self.stage(b"correct writable staged evidence")
        staged_path = self.root / staged.temporary_path
        staged_path.chmod(0o600)
        before = staged_path.stat()

        operations = (
            lambda: self.store.verify_staged(staged),
            lambda: self.store.staged_exists(staged),
            lambda: self.store.publish(staged),
            lambda: self.store.remove_staged(staged),
        )
        for operation in operations:
            with self.assertRaises(errors.StorageCorruptionError):
                operation()

        after = staged_path.stat()
        self.assertEqual((after.st_dev, after.st_ino), (before.st_dev, before.st_ino))
        self.assertEqual(staged_path.read_bytes(), b"correct writable staged evidence")
        self.assertEqual(stat.S_IMODE(after.st_mode), 0o600)
        self.assertFalse(self.raw_path(staged).exists())

    def test_mode_change_during_hash_verification_fails_closed(self) -> None:
        staged = self.stage(b"mode changes during verification")
        staged_path = self.root / staged.temporary_path
        inode = staged_path.stat().st_ino
        original_hash = self.store._hash_descriptor

        def hash_then_make_writable(descriptor: int) -> str:
            digest = original_hash(descriptor)
            os.fchmod(descriptor, 0o600)
            return digest

        with patch.object(
            self.store, "_hash_descriptor", side_effect=hash_then_make_writable
        ):
            with self.assertRaises(errors.StorageCorruptionError):
                self.store.verify_staged(staged)

        self.assertEqual(staged_path.stat().st_ino, inode)
        self.assertEqual(staged_path.read_bytes(), b"mode changes during verification")
        self.assertEqual(stat.S_IMODE(staged_path.stat().st_mode), 0o600)

    def test_published_mode_change_during_hash_verification_fails_closed(self) -> None:
        staged = self.stage(b"published mode changes during verification")
        publication = self.store.publish(staged)
        self.store.remove_staged(staged)
        target = self.root / publication.storage_path
        inode = target.stat().st_ino
        original_hash = self.store._hash_descriptor

        def hash_then_make_writable(descriptor: int) -> str:
            digest = original_hash(descriptor)
            os.fchmod(descriptor, 0o600)
            return digest

        with patch.object(
            self.store, "_hash_descriptor", side_effect=hash_then_make_writable
        ):
            with self.assertRaises(errors.StorageCorruptionError):
                self.store.verify_published(publication)

        self.assertEqual(target.stat().st_ino, inode)
        self.assertEqual(
            target.read_bytes(), b"published mode changes during verification"
        )
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)

    def test_hard_link_race_has_one_creator_and_identical_inode(self) -> None:
        assets = (
            self.store.stage(BytesIO(b"racing bytes"), intent_id=self.intent()),
            self.store.stage(BytesIO(b"racing bytes"), intent_id=self.intent()),
        )
        barrier = threading.Barrier(2)
        results: list[tuple[StagedAsset, PublicationResult]] = []
        failures: list[BaseException] = []

        def publish(asset: StagedAsset) -> None:
            try:
                barrier.wait(timeout=2)
                results.append((asset, self.store.publish(asset)))
            except BaseException as error:
                failures.append(error)

        threads = [threading.Thread(target=publish, args=(asset,)) for asset in assets]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=3)

        self.assertEqual(failures, [])
        self.assertEqual(sorted(result.created for _, result in results), [False, True])
        target_inode = self.raw_path(assets[0]).stat().st_ino
        creator = next(asset for asset, result in results if result.created)
        self.assertEqual((self.root / creator.temporary_path).stat().st_ino, target_inode)

    def test_exdev_is_typed_and_has_no_copy_fallback(self) -> None:
        staged = self.stage()
        cross_device = OSError(errno.EXDEV, "cross-device link")

        with patch.object(manager.os, "link", side_effect=cross_device):
            with self.assertRaises(errors.CrossDeviceStorageError):
                self.store.publish(staged)

        self.assertFalse(self.raw_path(staged).exists())
        self.assertTrue((self.root / staged.temporary_path).exists())

    def test_root_and_managed_symlinks_are_rejected(self) -> None:
        with TemporaryDirectory() as directory:
            base = Path(directory)
            real = base / "real"
            real.mkdir()
            alias = base / "alias"
            alias.symlink_to(real, target_is_directory=True)
            with self.assertRaises(errors.StoragePathError):
                RawAssetStore(alias)

            child = real / "child"
            child.mkdir()
            with self.assertRaises(errors.StoragePathError):
                RawAssetStore(alias / "child")

            unsafe = base / "unsafe"
            unsafe.mkdir()
            (unsafe / "staging").symlink_to(real, target_is_directory=True)
            with self.assertRaises(errors.StoragePathError):
                RawAssetStore(unsafe)

    def test_symlink_shard_target_and_staged_file_are_rejected(self) -> None:
        staged = self.stage(b"symlink checks")
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        shard = self.root / "raw" / staged.sha256[:2]
        shard.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(errors.StoragePathError):
            self.store.publish(staged)
        shard.unlink()

        shard.mkdir(mode=0o700)
        external_file = outside / "external"
        external_file.write_bytes(b"symlink checks")
        (shard / staged.sha256).symlink_to(external_file)
        with self.assertRaises(errors.StorageCorruptionError):
            self.store.publish(staged)
        self.assertTrue((shard / staged.sha256).is_symlink())

        other_id = self.intent()
        staged_link = self.root / "staging" / f"{other_id}.part"
        staged_link.symlink_to(external_file)
        with self.assertRaises(errors.StorageConflictError):
            self.store.stage(BytesIO(b"new"), intent_id=other_id)
        forged = StagedAsset(
            other_id,
            f"staging/{other_id}.part",
            hashlib.sha256(b"symlink checks").hexdigest(),
            len(b"symlink checks"),
        )
        with self.assertRaises(errors.StorageCorruptionError):
            self.store.verify_staged(forged)

    def test_record_paths_reject_traversal_and_mismatched_ownership(self) -> None:
        intent_id = self.intent()
        sha256 = "a" * 64
        for path in (
            f"staging/../{intent_id}.part",
            f"staging/{self.intent()}.part",
            f"/staging/{intent_id}.part",
        ):
            with self.subTest(path=path), self.assertRaises(ValueError):
                StagedAsset(intent_id, path, sha256, 1)
        with self.assertRaises(ValueError):
            PublicationResult(f"raw/../{sha256}", sha256, 1, False)

    def test_exclusive_lock_waits_for_shared_coordinator_lock(self) -> None:
        attempted = threading.Event()
        acquired = threading.Event()

        def reconcile() -> None:
            attempted.set()
            with self.store.lock(exclusive=True):
                acquired.set()

        with self.store.lock():
            thread = threading.Thread(target=reconcile)
            thread.start()
            self.assertTrue(attempted.wait(timeout=1))
            time.sleep(0.05)
            self.assertFalse(acquired.is_set())
        thread.join(timeout=2)
        self.assertTrue(acquired.is_set())

    def test_staging_enumeration_separates_and_preserves_unknown_entries(self) -> None:
        staged = self.stage()
        unknown_file = self.root / "staging" / "unknown.tmp"
        unknown_file.write_bytes(b"unknown")
        unknown_directory = self.root / "staging" / "manual"
        unknown_directory.mkdir()
        link_id = self.intent()
        unknown_link = self.root / "staging" / f"{link_id}.part"
        unknown_link.symlink_to(unknown_file)

        recognized, unknown = self.store.enumerate_staging()

        self.assertEqual(recognized, (staged.temporary_path,))
        self.assertEqual(
            unknown,
            tuple(
                sorted(
                    (
                        f"staging/{link_id}.part",
                        "staging/manual",
                        "staging/unknown.tmp",
                    )
                )
            ),
        )
        self.assertTrue(unknown_file.exists())
        self.assertTrue(unknown_directory.exists())
        self.assertTrue(unknown_link.is_symlink())

    def test_publish_fsync_failure_is_not_suppressed_or_rolled_back(self) -> None:
        staged = self.stage()
        with patch.object(
            manager.os,
            "fsync",
            side_effect=[None, None, OSError("fsync failed")],
        ):
            with self.assertRaises(errors.DurabilityError):
                self.store.publish(staged)

        self.assertTrue(self.raw_path(staged).exists())
        self.assertEqual(self.raw_path(staged).read_bytes(), b"raw evidence")

    def test_missing_nondirectory_and_initialization_fsync_fail_closed(self) -> None:
        with TemporaryDirectory() as directory:
            base = Path(directory)
            with self.assertRaises(errors.StoragePathError):
                RawAssetStore(base / "missing")
            regular = base / "file"
            regular.write_bytes(b"x")
            with self.assertRaises(errors.StoragePathError):
                RawAssetStore(regular)
            root = base / "root"
            root.mkdir()
            with patch.object(manager.os, "fsync", side_effect=OSError("fsync failed")):
                with self.assertRaises(errors.DurabilityError):
                    RawAssetStore(root)

    def test_storage_import_has_no_catalog_dependency_or_filesystem_io(self) -> None:
        source = (SRC / "sciretriever/storage/manager.py").read_text(encoding="utf-8")
        self.assertNotIn("sciretriever.catalog", source)
        for name in tuple(sys.modules):
            if name == "sciretriever.storage" or name.startswith("sciretriever.storage."):
                sys.modules.pop(name)
        with patch.object(os, "open", side_effect=AssertionError("import touched filesystem")):
            imported = importlib.import_module("sciretriever.storage")
        self.assertIsNotNone(imported.RawAssetStore)


class StorageRecordTests(TestCase):
    def test_records_are_frozen_slotted_and_validate_types(self) -> None:
        intent_id = str(uuid4())
        sha256 = "a" * 64
        staged = StagedAsset(intent_id, f"staging/{intent_id}.part", sha256, 1)
        with self.assertRaises((AttributeError, TypeError)):
            staged.byte_size = 2
        with self.assertRaises((TypeError, ValueError)):
            records.StagedAsset(intent_id, f"staging/{intent_id}.part", sha256, False)
        with self.assertRaises(TypeError):
            records.PublicationResult(f"raw/aa/{sha256}", sha256, 1, 1)


if __name__ == "__main__":
    import unittest

    unittest.main()
