from __future__ import annotations

import os
import signal
import stat
import subprocess
import sys
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from sciretriever.storage.locking import (
    CatalogLockConflictError,
    CatalogLockError,
    CatalogLockSecurityError,
    CatalogLockStateError,
    CatalogWriteLock,
)

_CHILD_SCRIPT = r"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.getcwd(), "src"))
from sciretriever.storage.locking import CatalogWriteLock

path = sys.argv[1]
mode = sys.argv[2]
with CatalogWriteLock(path):
    print("ready", flush=True)
    if mode == "hold":
        time.sleep(30)
"""


class StorageLockingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-storage-lock-")
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)
        os.chmod(self.parent, 0o700)
        self.catalog = self.parent / "catalog.sqlite"
        self.catalog.write_bytes(b"catalog")
        os.chmod(self.catalog, 0o600)

    def _lock_entries(self) -> tuple[Path, ...]:
        lock_directory = self.parent / ".sciretriever-locks"
        return tuple(lock_directory.glob("*.lock"))

    def _start_child(self, path: Path, mode: str = "hold") -> subprocess.Popen[str]:
        return subprocess.Popen(
            [sys.executable, "-c", _CHILD_SCRIPT, str(path), mode],
            cwd=Path.cwd(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def _wait_ready(self, process: subprocess.Popen[str]) -> None:
        self.assertIsNotNone(process.stdout)
        assert process.stdout is not None
        ready = process.stdout.readline().strip()
        self.assertEqual(ready, "ready")

    def _stop_child(self, process: subprocess.Popen[str]) -> None:
        try:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=5)
        finally:
            self._close_child_pipes(process)

    def _close_child_pipes(self, process: subprocess.Popen[str]) -> None:
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                stream.close()

    def test_same_process_is_exclusive_and_non_reentrant(self) -> None:
        first = CatalogWriteLock(self.catalog)
        first.acquire()
        self.addCleanup(first.release)

        with self.assertRaises(CatalogLockConflictError):
            CatalogWriteLock(self.catalog).acquire()
        with self.assertRaises(CatalogLockStateError):
            first.acquire()

    def test_context_release_happens_after_exception(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "body failure"):
            with CatalogWriteLock(self.catalog):
                raise RuntimeError("body failure")

        with CatalogWriteLock(self.catalog):
            pass

    def test_lexical_aliases_share_one_lock(self) -> None:
        alias = self.parent / "nested" / ".." / self.catalog.name
        first = CatalogWriteLock(self.catalog)
        first.acquire()
        self.addCleanup(first.release)

        with self.assertRaises(CatalogLockConflictError):
            CatalogWriteLock(alias).acquire()

    def test_different_catalogs_are_independent(self) -> None:
        other = self.parent / "other.sqlite"
        other.write_bytes(b"other")
        os.chmod(other, 0o600)

        with CatalogWriteLock(self.catalog):
            with CatalogWriteLock(other):
                pass

    def test_symlink_hardlink_and_parent_symlink_fail_closed(self) -> None:
        target_link = self.parent / "catalog-link.sqlite"
        target_link.symlink_to(self.catalog)
        with self.assertRaises(CatalogLockError):
            CatalogWriteLock(target_link).acquire()

        hardlink = self.parent / "catalog-hardlink.sqlite"
        os.link(self.catalog, hardlink)
        with self.assertRaises(CatalogLockError):
            CatalogWriteLock(hardlink).acquire()

        linked_parent = self.parent / "linked-parent"
        linked_parent.symlink_to(self.parent, target_is_directory=True)
        with self.assertRaises(CatalogLockError):
            CatalogWriteLock(linked_parent / self.catalog.name).acquire()

    def test_parent_replacement_is_rejected(self) -> None:
        nested = self.parent / "nested"
        nested.mkdir(mode=0o700)
        catalog = nested / "catalog.sqlite"
        catalog.write_bytes(b"nested")
        os.chmod(catalog, 0o600)
        lock = CatalogWriteLock(catalog)

        moved = self.parent / "nested-old"
        nested.rename(moved)
        nested.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(CatalogLockSecurityError):
            lock.acquire()

    def test_lock_directory_and_entry_are_owner_only_and_path_free(self) -> None:
        with CatalogWriteLock(self.catalog):
            lock_directory = self.parent / ".sciretriever-locks"
            self.assertTrue(lock_directory.is_dir())
            self.assertEqual(stat.S_IMODE(lock_directory.stat().st_mode), 0o700)
            self.assertEqual(lock_directory.stat().st_uid, os.geteuid())
            entries = self._lock_entries()
            self.assertEqual(len(entries), 1)
            entry = entries[0]
            metadata = entry.stat()
            self.assertTrue(stat.S_ISREG(metadata.st_mode))
            self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o600)
            self.assertEqual(metadata.st_uid, os.geteuid())
            self.assertEqual(metadata.st_nlink, 1)
            self.assertNotIn(str(self.catalog), entry.name)
            self.assertNotIn(str(self.catalog), repr(CatalogWriteLock(self.catalog)))

    def test_existing_catalog_and_lock_permissions_do_not_control_admission(self) -> None:
        os.chmod(self.parent, 0o777)
        os.chmod(self.catalog, 0o666)
        with CatalogWriteLock(self.catalog):
            pass
        lock_directory = self.parent / ".sciretriever-locks"
        lock_file = self._lock_entries()[0]
        os.chmod(lock_directory, 0o777)
        os.chmod(lock_file, 0o666)

        with CatalogWriteLock(self.catalog):
            pass

    def test_replaced_lock_entry_is_rejected(self) -> None:
        first = CatalogWriteLock(self.catalog)
        first.acquire()
        self.addCleanup(first.release)
        entry = self._lock_entries()[0]
        replacement = self.parent / "replacement.lock"
        replacement.write_bytes(b"replacement")
        os.chmod(replacement, 0o600)
        entry.unlink()
        replacement.rename(entry)

        with self.assertRaises(CatalogLockSecurityError):
            CatalogWriteLock(self.catalog).acquire()

    def test_replaced_lock_entry_symlink_is_rejected(self) -> None:
        first = CatalogWriteLock(self.catalog)
        first.acquire()
        self.addCleanup(first.release)
        entry = self._lock_entries()[0]
        replacement = self.parent / "replacement-target.lock"
        replacement.write_bytes(b"replacement")
        os.chmod(replacement, 0o600)
        entry.unlink()
        entry.symlink_to(replacement)

        with self.assertRaises(CatalogLockSecurityError):
            CatalogWriteLock(self.catalog).acquire()

    def test_child_process_conflict_is_immediate_and_releases_after_exit(self) -> None:
        child = self._start_child(self.catalog)
        self.addCleanup(self._stop_child, child)
        self._wait_ready(child)

        started = time.monotonic()
        with self.assertRaises(CatalogLockConflictError):
            CatalogWriteLock(self.catalog).acquire()
        self.assertLess(time.monotonic() - started, 1.0)

        self._stop_child(child)
        with CatalogWriteLock(self.catalog):
            pass

    def test_two_child_processes_same_catalog_are_serialized(self) -> None:
        first = self._start_child(self.catalog)
        second: subprocess.Popen[str] | None = None
        self.addCleanup(self._stop_child, first)
        self._wait_ready(first)
        try:
            second = self._start_child(self.catalog)
            self.addCleanup(self._stop_child, second)
            self.assertIsNotNone(second.stdout)
            assert second.stdout is not None
            self.assertEqual(second.stdout.readline(), "")
            self.assertNotEqual(second.wait(timeout=5), 0)
        finally:
            self._stop_child(first)

        with CatalogWriteLock(self.catalog):
            pass

    def test_child_normal_exit_releases_lock(self) -> None:
        child = self._start_child(self.catalog, "exit")
        self._wait_ready(child)
        try:
            self.assertEqual(child.wait(timeout=5), 0)
        finally:
            self._close_child_pipes(child)

        with CatalogWriteLock(self.catalog):
            pass

    def test_child_kill_releases_lock(self) -> None:
        child = self._start_child(self.catalog)
        self._wait_ready(child)
        child.send_signal(signal.SIGKILL)
        try:
            self.assertIsNotNone(child.wait(timeout=5))
        finally:
            self._close_child_pipes(child)

        with CatalogWriteLock(self.catalog):
            pass

    def test_release_without_acquire_is_a_state_error(self) -> None:
        with self.assertRaises(CatalogLockStateError):
            CatalogWriteLock(self.catalog).release()


if __name__ == "__main__":
    unittest.main()
