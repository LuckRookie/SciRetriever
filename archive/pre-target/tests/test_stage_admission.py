from __future__ import annotations

import hashlib
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
from unittest import TestCase
from unittest.mock import patch

from sciretriever.cli.stage_admission import StageKind, admit_catalog_stages
from sciretriever.errors import StageAdmissionConflict


_WORKER = """
import pathlib
import os
import sys
import time
from sciretriever.cli.stage_admission import StageKind, admit_catalog_stages
from sciretriever.errors import StageAdmissionConflict

catalog, stages_raw, ready_raw, release_raw, sentinel_raw, result_raw = sys.argv[1:]
stages = tuple(StageKind(value) for value in stages_raw.split(','))
ready = pathlib.Path(ready_raw)
release = pathlib.Path(release_raw)
sentinel = pathlib.Path(sentinel_raw)
result = pathlib.Path(result_raw)
try:
    with admit_catalog_stages(catalog, stages):
        sentinel.touch()
        ready.write_text(os.environ['TMPDIR'], encoding='utf-8')
        deadline = time.monotonic() + 10
        while not release.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        if not release.exists():
            result.write_text('HUNG', encoding='ascii')
            raise SystemExit(4)
except StageAdmissionConflict as error:
    result.write_text(f'CONFLICT:{error.stage.value}:{error}', encoding='ascii')
    raise SystemExit(3)
result.write_text('RELEASED', encoding='ascii')
"""


class StageAdmissionTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.catalog = self.root / "catalog.sqlite"
        self.catalog.touch()
        self.processes: list[subprocess.Popen[str]] = []

    def tearDown(self) -> None:
        for process in self.processes:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=3)
        for stage in StageKind:
            lock_path = self._lock_path(self.catalog, stage)
            if lock_path.is_dir():
                lock_path.rmdir()
            else:
                lock_path.unlink(missing_ok=True)
        admission_directory = Path("/tmp") / f"sciretriever-stage-admission-{os.getuid()}"
        try:
            admission_directory.rmdir()
        except OSError:
            pass
        self.temporary.cleanup()

    def _lock_path(self, catalog: Path, stage: StageKind) -> Path:
        identity = hashlib.sha256(f"{catalog.resolve()}\0{stage.value}".encode()).hexdigest()
        directory = Path("/tmp") / f"sciretriever-stage-admission-{os.getuid()}"
        return directory / f"{identity}.sqlite"

    def _start(
        self,
        catalog: Path,
        stages: tuple[StageKind, ...],
        label: str,
    ) -> tuple[subprocess.Popen[str], Path, Path, Path, Path]:
        ready = self.root / f"{label}.ready"
        release = self.root / f"{label}.release"
        sentinel = self.root / f"{label}.external-call"
        result = self.root / f"{label}.result"
        process_temp = self.root / f"{label}.tmp"
        process_temp.mkdir()
        environment = {
            **os.environ,
            "TMPDIR": str(process_temp),
            "TEMP": str(process_temp),
            "TMP": str(process_temp),
        }
        process = subprocess.Popen(
            [
                sys.executable,
                "-c",
                _WORKER,
                str(catalog),
                ",".join(stage.value for stage in stages),
                str(ready),
                str(release),
                str(sentinel),
                str(result),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=environment,
        )
        self.processes.append(process)
        return process, ready, release, sentinel, result

    def _finish(self, process: subprocess.Popen[str], timeout: float = 3) -> int:
        process.communicate(timeout=timeout)
        assert process.returncode is not None
        return process.returncode

    def _await_file(self, path: Path, process: subprocess.Popen[str]) -> None:
        deadline = time.monotonic() + 5
        while not path.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        if not path.exists():
            stdout, stderr = process.communicate(timeout=1)
            self.fail(f"worker did not create {path.name}: rc={process.returncode}, stdout={stdout!r}, stderr={stderr!r}")

    def test_same_stage_alias_conflicts_immediately_before_external_call(self) -> None:
        holder, ready, release, _, _ = self._start(self.catalog.resolve(), (StageKind.ACQUISITION,), "holder")
        self._await_file(ready, holder)
        self.assertEqual(ready.read_text(encoding="utf-8"), str(self.root / "holder.tmp"))

        started = time.monotonic()
        alias = self.catalog.parent / "." / self.catalog.name
        contender, _, _, sentinel, result = self._start(alias, (StageKind.ACQUISITION,), "contender")
        self.assertEqual(self._finish(contender), 3)

        self.assertLess(time.monotonic() - started, 2)
        self.assertNotEqual(self.root / "holder.tmp", self.root / "contender.tmp")
        self.assertFalse(sentinel.exists())
        expected = "CONFLICT:acquisition:acquisition stage is already active for this catalog"
        self.assertEqual(result.read_text(encoding="ascii"), expected)
        self.assertNotIn(str(self.catalog), result.read_text(encoding="ascii"))
        release.touch()
        self.assertEqual(self._finish(holder), 0)

    def test_different_stages_coexist_and_fixed_multi_stage_order_conflicts(self) -> None:
        acquisition, acquisition_ready, acquisition_release, _, _ = self._start(self.catalog, (StageKind.ACQUISITION,), "acquisition")
        analysis, analysis_ready, analysis_release, _, _ = self._start(self.catalog, (StageKind.ANALYSIS,), "analysis")
        self._await_file(acquisition_ready, acquisition)
        self._await_file(analysis_ready, analysis)

        mixed_stages = (StageKind.ANALYSIS, StageKind.ACQUISITION)
        mixed, _, _, mixed_sentinel, mixed_result = self._start(self.catalog, mixed_stages, "mixed")
        self.assertEqual(self._finish(mixed), 3)
        self.assertFalse(mixed_sentinel.exists())
        self.assertEqual(
            mixed_result.read_text(encoding="ascii").split(":", maxsplit=2)[1],
            "acquisition",
        )
        acquisition_release.touch()
        analysis_release.touch()
        self.assertEqual(self._finish(acquisition), 0)
        self.assertEqual(self._finish(analysis), 0)

    def test_process_death_releases_lock_and_stale_file_has_no_schema_or_rows(self) -> None:
        for attempt in range(2):
            holder, ready, _, _, _ = self._start(
                self.catalog,
                (StageKind.ACQUISITION,),
                f"crash-holder-{attempt}",
            )
            self._await_file(ready, holder)
            holder.kill()
            self.assertLess(self._finish(holder), 0)

        successor, successor_ready, successor_release, _, _ = self._start(
            self.catalog, (StageKind.ACQUISITION,), "successor"
        )
        self._await_file(successor_ready, successor)
        successor_release.touch()
        self.assertEqual(self._finish(successor), 0)

        lock_path = self._lock_path(self.catalog, StageKind.ACQUISITION)
        directory_stat = lock_path.parent.lstat()
        lock_stat = lock_path.lstat()
        self.assertTrue(stat.S_ISDIR(directory_stat.st_mode))
        self.assertEqual(stat.S_IMODE(directory_stat.st_mode), 0o700)
        self.assertEqual(directory_stat.st_uid, os.getuid())
        self.assertTrue(stat.S_ISREG(lock_stat.st_mode))
        self.assertEqual(stat.S_IMODE(lock_stat.st_mode), 0o600)
        self.assertEqual(lock_stat.st_uid, os.getuid())
        with sqlite3.connect(lock_path) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT name FROM sqlite_schema WHERE type='table'"
                ).fetchall(),
                [],
            )

    def test_exception_releases_all_locks_and_non_lock_sqlite_error_propagates(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "body failed"):
            with admit_catalog_stages(
                self.catalog,
                (StageKind.ANALYSIS, StageKind.ACQUISITION),
            ):
                raise RuntimeError("body failed")
        with admit_catalog_stages(
            self.catalog,
            (StageKind.ACQUISITION, StageKind.ANALYSIS),
        ):
            pass

        lock_path = self._lock_path(self.catalog, StageKind.ANALYSIS)
        lock_path.unlink()
        lock_path.mkdir(mode=0o700)
        with self.assertRaises(IsADirectoryError):
            with admit_catalog_stages(self.catalog, (StageKind.ANALYSIS,)):
                pass
        lock_path.rmdir()
        lock_path.write_bytes(b"not a sqlite database")
        lock_path.chmod(0o600)
        with self.assertRaises(sqlite3.DatabaseError):
            with admit_catalog_stages(self.catalog, (StageKind.ANALYSIS,)):
                pass

    def test_admission_directory_rejects_symlink_and_non_directory_collisions(self) -> None:
        fake_temp = self.root / "fake-temp"
        fake_temp.mkdir()
        collision = fake_temp / f"sciretriever-stage-admission-{os.getuid()}"
        target = self.root / "target"
        target.mkdir()
        collision.symlink_to(target, target_is_directory=True)
        with patch("sciretriever.cli.stage_admission._HOST_TEMP_ROOT", fake_temp):
            with self.assertRaises(OSError):
                with admit_catalog_stages(self.catalog, (StageKind.ACQUISITION,)):
                    pass
        collision.unlink()
        collision.write_text("collision", encoding="ascii")
        with patch("sciretriever.cli.stage_admission._HOST_TEMP_ROOT", fake_temp):
            with self.assertRaises(NotADirectoryError):
                with admit_catalog_stages(self.catalog, (StageKind.ACQUISITION,)):
                    pass

    def test_existing_directory_and_lock_file_require_owner_only_modes(self) -> None:
        fake_temp = self.root / "mode-temp"
        fake_temp.mkdir()
        admission_directory = fake_temp / f"sciretriever-stage-admission-{os.getuid()}"
        admission_directory.mkdir(mode=0o755)
        admission_directory.chmod(0o755)
        with patch("sciretriever.cli.stage_admission._HOST_TEMP_ROOT", fake_temp):
            with self.assertRaises(PermissionError):
                with admit_catalog_stages(self.catalog, (StageKind.ACQUISITION,)):
                    pass

        admission_directory.chmod(0o700)
        lock_path = admission_directory / self._lock_path(
            self.catalog, StageKind.ACQUISITION
        ).name
        lock_path.touch(mode=0o644)
        lock_path.chmod(0o644)
        with patch("sciretriever.cli.stage_admission._HOST_TEMP_ROOT", fake_temp):
            with self.assertRaises(PermissionError):
                with admit_catalog_stages(self.catalog, (StageKind.ACQUISITION,)):
                    pass

    def test_conflict_exposes_only_typed_stage(self) -> None:
        error = StageAdmissionConflict(StageKind.ANALYSIS)

        self.assertIs(error.stage, StageKind.ANALYSIS)
        self.assertEqual(str(error), "analysis stage is already active for this catalog")
