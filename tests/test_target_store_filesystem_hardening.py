from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sciretriever.literature_store.filesystem import AdvisoryLock, canonical_catalog_path
from sciretriever.literature_store.sqlite import (
    UnsupportedCatalogError,
    create_or_open_catalog,
    open_read_only_snapshot,
    validate_catalog,
)
from sciretriever.literature_store.sqlite import engine as engine_module


class TargetStoreFilesystemHardeningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-debug6-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)
        self.catalog = self.root / "catalog.sqlite"

    def test_live_read_snapshot_observes_uncheckpointed_committed_wal(self) -> None:
        writer_manager = create_or_open_catalog(self.catalog)
        writer = writer_manager.__enter__()
        self.addCleanup(writer_manager.__exit__, None, None, None)
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("INSERT INTO works(id) VALUES ('wal-visible')")
        writer.commit()
        self.assertGreater(Path(f"{self.catalog}-wal").stat().st_size, 0)

        with open_read_only_snapshot(self.catalog) as reader:
            count = reader.execute("SELECT count(*) FROM works WHERE id='wal-visible'").fetchone()[
                0
            ]

        self.assertEqual(count, 1)

    def test_quiescent_admission_remains_side_effect_free(self) -> None:
        with create_or_open_catalog(self.catalog):
            pass
        Path(f"{self.catalog}-wal").unlink(missing_ok=True)
        Path(f"{self.catalog}-shm").unlink(missing_ok=True)
        before = self.catalog.stat()

        validate_catalog(self.catalog)

        after = self.catalog.stat()
        self.assertEqual((after.st_ino, after.st_mtime_ns), (before.st_ino, before.st_mtime_ns))
        self.assertFalse(Path(f"{self.catalog}-wal").exists())
        self.assertFalse(Path(f"{self.catalog}-shm").exists())

    def test_catalog_uri_delimiters_are_treated_as_filename_bytes(self) -> None:
        for delimiter in ("?", "#"):
            catalog = self.root / f"catalog{delimiter}evidence.sqlite"
            with self.subTest(delimiter=delimiter):
                with create_or_open_catalog(catalog) as writer:
                    writer.execute("INSERT INTO works(id) VALUES ('intended-catalog')")
                    writer.commit()

                with open_read_only_snapshot(catalog) as reader:
                    row = reader.execute(
                        "SELECT id FROM works WHERE id='intended-catalog'"
                    ).fetchone()

                self.assertEqual(row, ("intended-catalog",))

    def test_replaced_lock_entry_does_not_admit_second_owner(self) -> None:
        scope = canonical_catalog_path(self.catalog)
        first = AdvisoryLock(scope, "core-write")
        with first.acquire():
            lock_root = self.root / ".sciretriever-locks"
            lock_entry = next(path for path in lock_root.iterdir() if path.name.endswith(".lock"))
            lock_entry.unlink()
            lock_entry.write_bytes(b"")
            os.chmod(lock_entry, 0o600)
            with self.assertRaises((BlockingIOError, OSError)):
                with AdvisoryLock(scope, "core-write").acquire(blocking=False):
                    self.fail("replacement lock admitted a concurrent owner")

    def test_catalog_symlink_replacement_before_writable_open_fails_closed(self) -> None:
        alternate = self.root / "alternate.sqlite"
        with create_or_open_catalog(self.catalog) as target:
            target.execute("INSERT INTO works(id) VALUES ('target-only')")
            target.commit()
        with create_or_open_catalog(alternate) as other:
            other.execute("INSERT INTO works(id) VALUES ('alternate-only')")
            other.commit()
        real_open = engine_module._writable_connection

        def replace_then_open(scope, timeout_ms):
            self.catalog.unlink()
            self.catalog.symlink_to(alternate)
            return real_open(scope, timeout_ms)

        with patch.object(engine_module, "_writable_connection", replace_then_open):
            with self.assertRaises(UnsupportedCatalogError):
                create_or_open_catalog(self.catalog)

    def test_catalog_regular_file_replacement_before_open_fails_closed(self) -> None:
        alternate = self.root / "alternate.sqlite"
        with create_or_open_catalog(self.catalog):
            pass
        with create_or_open_catalog(alternate):
            pass
        real_open = engine_module._writable_connection

        def replace_then_open(scope, timeout_ms):
            self.catalog.unlink()
            os.link(alternate, self.catalog)
            alternate.unlink()
            return real_open(scope, timeout_ms)

        with patch.object(engine_module, "_writable_connection", replace_then_open):
            with self.assertRaises(UnsupportedCatalogError):
                create_or_open_catalog(self.catalog)

    def test_abrupt_bootstrap_crashes_recover_without_owned_temps(self) -> None:
        for checkpoint in ("after-temporary-fsync", "after-publication"):
            path = self.root / f"crash-{checkpoint}.sqlite"
            script = (
                "import os; from sciretriever.literature_store.sqlite "
                "import create_or_open_catalog; "
                f"create_or_open_catalog({str(path)!r},"
                f"checkpoint=lambda name: os._exit(91) if name=={checkpoint!r} else None)"
            )
            result = subprocess.run(
                [sys.executable, "-c", script], check=False, capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 91, result.stderr)

            with create_or_open_catalog(path) as connection:
                self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone(), ("ok",))

            self.assertEqual(tuple(self.root.glob(f".{path.name}.bootstrap-*.tmp")), ())
            self.assertEqual(path.stat().st_nlink, 1)

    def test_recovery_preserves_unrelated_bootstrap_like_entry(self) -> None:
        unrelated = self.root / f".{self.catalog.name}.bootstrap-not-a-uuid.tmp"
        unrelated.write_bytes(b"preserved")
        os.chmod(unrelated, 0o600)

        with create_or_open_catalog(self.catalog):
            pass

        self.assertEqual(unrelated.read_bytes(), b"preserved")


if __name__ == "__main__":
    unittest.main()
