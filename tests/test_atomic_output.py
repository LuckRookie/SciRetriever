from __future__ import annotations

import hashlib
import io
import os
import stat
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import sciretriever.storage.files.output as output_module
from sciretriever.entry.ports import AtomicUserOutputPort
from sciretriever.model.primitives import Sha256
from sciretriever.storage.files.output import (
    AtomicOutput,
    AtomicOutputError,
    OutputConflictError,
    OutputIntegrityError,
    OutputResult,
    write_atomic,
)


class _ManagedReader:
    def __init__(self, payload: bytes) -> None:
        self.stream = io.BytesIO(payload)
        self.entered = False
        self.exited = False

    def __enter__(self) -> io.BytesIO:
        self.entered = True
        return self.stream

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        self.exited = True
        self.stream.close()
        return False


class _FailingReader:
    def __init__(self, exception: BaseException) -> None:
        self.exception = exception

    def read(self, size: int = -1) -> bytes:
        del size
        raise self.exception


class AtomicOutputTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-atomic-output-")
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)
        os.chmod(self.parent, 0o700)
        self.target = self.parent / "export.txt"
        self.payload = b"new complete output\n"
        self.old_payload = b"old complete output\n"

    def _write_old(self) -> None:
        self.target.write_bytes(self.old_payload)
        os.chmod(self.target, 0o600)

    def _staging_entries(self) -> tuple[Path, ...]:
        return tuple(self.parent.glob(".sciretriever-output-*.staging"))

    def _publication_entries(self) -> tuple[Path, ...]:
        return tuple(self.parent.glob(".sciretriever-output-*"))

    def _assert_result(self, result: OutputResult, payload: bytes) -> None:
        self.assertEqual(result.byte_size, len(payload))
        self.assertEqual(result.sha256, Sha256(hashlib.sha256(payload).hexdigest()))
        self.assertNotIn(str(self.target), repr(result))
        self.assertFalse(hasattr(result, "path"))

    def test_new_output_is_owner_only_atomic_and_returns_only_hash_and_size(self) -> None:
        managed = _ManagedReader(self.payload)

        result = write_atomic(self.target, managed)

        self._assert_result(result, self.payload)
        self.assertEqual(self.target.read_bytes(), self.payload)
        metadata = self.target.stat()
        self.assertTrue(stat.S_ISREG(metadata.st_mode))
        self.assertEqual(metadata.st_uid, os.geteuid())
        self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o600)
        self.assertTrue(managed.entered)
        self.assertTrue(managed.exited)
        self.assertEqual(self._staging_entries(), ())

    def test_existing_target_is_no_clobber_by_default(self) -> None:
        self._write_old()

        with self.assertRaises(OutputConflictError):
            write_atomic(self.target, self.payload)

        self.assertEqual(self.target.read_bytes(), self.old_payload)
        self.assertEqual(self._staging_entries(), ())

    def test_explicit_overwrite_replaces_complete_file_atomically(self) -> None:
        self._write_old()

        result = write_atomic(self.target, self.payload, overwrite=True)

        self._assert_result(result, self.payload)
        self.assertEqual(self.target.read_bytes(), self.payload)
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o600)
        self.assertEqual(self._staging_entries(), ())

    def test_parent_and_existing_target_permissions_do_not_control_admission(self) -> None:
        self._write_old()
        os.chmod(self.parent, 0o777)
        os.chmod(self.target, 0o666)

        result = write_atomic(self.target, self.payload, overwrite=True)

        self._assert_result(result, self.payload)
        self.assertEqual(self.target.read_bytes(), self.payload)

    def test_open_atomic_spools_past_memory_threshold_then_publishes(self) -> None:
        writer = AtomicOutput(max_bytes=16, spool_memory_bytes=4)
        payload = b"spooled output"

        with writer.open_atomic(self.target, overwrite=False) as destination:
            destination.write(payload)
            spool = getattr(destination, "_stream")
            self.assertTrue(getattr(spool, "_rolled"))

        self.assertEqual(self.target.read_bytes(), payload)
        self.assertEqual(self._publication_entries(), ())

    def test_open_atomic_enforces_max_bytes_before_publication(self) -> None:
        self._write_old()
        writer = AtomicOutput(max_bytes=8, spool_memory_bytes=4)
        overflow_observed = False

        with self.assertRaises(OutputIntegrityError):
            with writer.open_atomic(self.target, overwrite=True) as destination:
                destination.write(b"123456")
                spool = getattr(destination, "_stream")
                self.assertTrue(getattr(spool, "_rolled"))
                try:
                    destination.write(b"789")
                except OutputIntegrityError:
                    overflow_observed = True
                self.assertEqual(destination.seek(0, os.SEEK_END), 6)

        self.assertTrue(overflow_observed)
        self.assertEqual(self.target.read_bytes(), self.old_payload)
        self.assertEqual(self._publication_entries(), ())

    def test_open_atomic_body_failures_abort_and_preserve_existing_target(self) -> None:
        writer = AtomicOutput(max_bytes=16, spool_memory_bytes=4)
        for exception in (RuntimeError("encoding failed"), KeyboardInterrupt()):
            with self.subTest(exception=type(exception).__name__):
                self._write_old()
                with self.assertRaises(type(exception)) as caught:
                    with writer.open_atomic(self.target, overwrite=True) as destination:
                        destination.write(b"replacement")
                        raise exception
                self.assertIs(caught.exception, exception)
                self.assertEqual(self.target.read_bytes(), self.old_payload)
                self.assertEqual(self._publication_entries(), ())

    def test_open_atomic_directly_satisfies_entry_port_and_has_no_clobber_default(self) -> None:
        port: AtomicUserOutputPort = AtomicOutput(max_bytes=16, spool_memory_bytes=4)
        self.assertIsInstance(port, AtomicUserOutputPort)
        self._write_old()

        with self.assertRaises(OutputConflictError):
            with port.open_atomic(self.target) as destination:
                destination.write(b"replacement")
                self.assertEqual(self.target.read_bytes(), self.old_payload)

        self.assertEqual(self.target.read_bytes(), self.old_payload)
        self.assertEqual(self._publication_entries(), ())

    def test_open_atomic_explicit_overwrite_keeps_old_target_until_clean_exit(self) -> None:
        writer = AtomicOutput(max_bytes=16, spool_memory_bytes=4)
        self._write_old()

        with writer.open_atomic(self.target, overwrite=True) as destination:
            destination.write(b"replacement")
            self.assertEqual(self.target.read_bytes(), self.old_payload)

        self.assertEqual(self.target.read_bytes(), b"replacement")
        self.assertEqual(self._publication_entries(), ())

    def test_target_parent_and_nonregular_targets_fail_closed(self) -> None:
        outside = self.parent / "outside.txt"
        outside.write_bytes(b"outside")
        os.chmod(outside, 0o600)
        symlink_target = self.parent / "symlink-target"
        symlink_target.symlink_to(outside)
        directory_target = self.parent / "directory-target"
        directory_target.mkdir(mode=0o700)
        hardlink_target = self.parent / "hardlink-target"
        hardlink_alias = self.parent / "hardlink-alias"
        hardlink_target.write_bytes(self.old_payload)
        os.chmod(hardlink_target, 0o600)
        os.link(hardlink_target, hardlink_alias)

        for target in (symlink_target, directory_target, hardlink_target):
            with self.subTest(target=target.name):
                with self.assertRaises(AtomicOutputError):
                    write_atomic(target, self.payload, overwrite=True)
        self.assertEqual(outside.read_bytes(), b"outside")
        self.assertEqual(hardlink_alias.read_bytes(), self.old_payload)

        linked_parent = self.parent / "linked-parent"
        linked_parent.symlink_to(self.parent, target_is_directory=True)
        with self.assertRaises(AtomicOutputError):
            write_atomic(linked_parent / "escaped.txt", self.payload)
        self.assertFalse((self.parent / "escaped.txt").exists())
        self.assertEqual(self._staging_entries(), ())

    def test_expected_identity_mismatch_keeps_old_target_and_cleans_stage(self) -> None:
        self._write_old()

        with self.assertRaises(OutputIntegrityError):
            write_atomic(
                self.target,
                self.payload,
                overwrite=True,
                expected_sha256=Sha256("a" * 64),
                expected_size=len(self.payload),
            )
        self.assertEqual(self.target.read_bytes(), self.old_payload)
        self.assertEqual(self._staging_entries(), ())

        with self.assertRaises(OutputIntegrityError):
            write_atomic(
                self.target,
                self.payload,
                overwrite=True,
                expected_sha256=Sha256(hashlib.sha256(self.payload).hexdigest()),
                expected_size=len(self.payload) + 1,
            )
        self.assertEqual(self.target.read_bytes(), self.old_payload)
        self.assertEqual(self._staging_entries(), ())

    def test_source_exception_and_baseexception_propagate_with_cleanup(self) -> None:
        for exception in (RuntimeError("source failed"), KeyboardInterrupt()):
            with self.subTest(exception=type(exception).__name__):
                with self.assertRaises(type(exception)):
                    write_atomic(self.target, _FailingReader(exception))
                self.assertFalse(self.target.exists())
                self.assertEqual(self._staging_entries(), ())

    def test_prepublication_failpoints_keep_old_target_and_clean_stage(self) -> None:
        self._write_old()
        failpoints = (
            "staging-created",
            "staging-written",
            "staging-fsynced",
            "staging-verified",
            "before-publish",
        )
        for expected in failpoints:
            with self.subTest(failpoint=expected):

                def failpoint(name: str, expected_name: str = expected) -> None:
                    if name == expected_name:
                        raise RuntimeError("injected publication fault")

                with self.assertRaisesRegex(RuntimeError, "injected publication fault"):
                    write_atomic(
                        self.target,
                        self.payload,
                        overwrite=True,
                        failpoint=failpoint,
                    )
                self.assertEqual(self.target.read_bytes(), self.old_payload)
                self.assertEqual(self._staging_entries(), ())

    def test_postpublication_failpoints_restore_old_target(self) -> None:
        for expected in ("after-publish", "before-directory-fsync", "directory-fsynced"):
            with self.subTest(failpoint=expected):
                self._write_old()

                def failpoint(name: str, expected_name: str = expected) -> None:
                    if name == expected_name:
                        raise RuntimeError("post-publication fault")

                with self.assertRaisesRegex(RuntimeError, "post-publication fault"):
                    write_atomic(
                        self.target,
                        self.payload,
                        overwrite=True,
                        failpoint=failpoint,
                    )
                self.assertEqual(self.target.read_bytes(), self.old_payload)
                self.assertEqual(self._staging_entries(), ())

    def test_cleanup_failpoint_is_propagated_after_complete_publication(self) -> None:
        self._write_old()

        def failpoint(name: str) -> None:
            if name == "after-cleanup":
                raise RuntimeError("cleanup observer fault")

        with self.assertRaisesRegex(RuntimeError, "cleanup observer fault"):
            write_atomic(self.target, self.payload, overwrite=True, failpoint=failpoint)
        self.assertEqual(self.target.read_bytes(), self.old_payload)
        self.assertEqual(self._staging_entries(), ())

    def test_control_failures_propagate_after_overwrite_recovery(self) -> None:
        for exception_type in (KeyboardInterrupt, SystemExit, GeneratorExit):
            with self.subTest(exception=exception_type.__name__):
                self._write_old()
                marker = exception_type("publication cancelled")

                def failpoint(name: str, expected: BaseException = marker) -> None:
                    if name == "after-publish":
                        raise expected

                with self.assertRaises(exception_type) as caught:
                    write_atomic(
                        self.target,
                        self.payload,
                        overwrite=True,
                        failpoint=failpoint,
                    )
                self.assertIs(caught.exception, marker)
                self.assertEqual(self.target.read_bytes(), self.old_payload)
                self.assertEqual(self._staging_entries(), ())

    def test_fsync_failures_never_leave_a_partial_target(self) -> None:
        self._write_old()
        real_fsync = output_module.os.fsync

        def fail_file_fsync(descriptor: int) -> None:
            if stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise OSError("file fsync fault")
            real_fsync(descriptor)

        with mock.patch.object(output_module.os, "fsync", side_effect=fail_file_fsync):
            with self.assertRaises(AtomicOutputError):
                write_atomic(self.target, self.payload, overwrite=True)
        self.assertEqual(self.target.read_bytes(), self.old_payload)
        self.assertEqual(self._staging_entries(), ())

        def fail_directory_fsync(descriptor: int) -> None:
            if stat.S_ISDIR(os.fstat(descriptor).st_mode):
                raise OSError("directory fsync fault")
            real_fsync(descriptor)

        with mock.patch.object(output_module.os, "fsync", side_effect=fail_directory_fsync):
            with self.assertRaises(AtomicOutputError):
                write_atomic(self.target, self.payload, overwrite=True)
        self.assertEqual(self.target.read_bytes(), self.old_payload)
        self.assertEqual(self._staging_entries(), ())

    def test_target_identity_race_is_rejected_before_publish(self) -> None:
        self._write_old()

        def replace_target(name: str) -> None:
            if name == "before-publish":
                replacement = self.parent / "replacement"
                replacement.write_bytes(b"replacement")
                os.chmod(replacement, 0o600)
                os.replace(replacement, self.target)

        with self.assertRaises(AtomicOutputError):
            write_atomic(
                self.target,
                self.payload,
                overwrite=True,
                failpoint=replace_target,
            )
        self.assertEqual(self.target.read_bytes(), b"replacement")
        self.assertEqual(self._staging_entries(), ())

    def test_target_replacement_after_last_identity_check_is_not_overwritten(self) -> None:
        self._write_old()

        def replace_after_identity_check(name: str) -> None:
            if name == "after-identity-check":
                replacement = self.parent / "replacement-after-check"
                replacement.write_bytes(b"replacement")
                os.chmod(replacement, 0o600)
                os.replace(replacement, self.target)

        with self.assertRaises(OutputConflictError):
            write_atomic(
                self.target,
                self.payload,
                overwrite=True,
                failpoint=replace_after_identity_check,
            )
        self.assertEqual(self.target.read_bytes(), self.old_payload)
        evidence = tuple(
            path
            for path in self.parent.iterdir()
            if path != self.target and path.is_file() and path.read_bytes() == b"replacement"
        )
        self.assertEqual(len(evidence), 1)

    def test_raced_staging_and_backup_objects_are_preserved(self) -> None:
        self._write_old()

        def replace_private_backup(name: str) -> None:
            if name == "after-publish":
                backup = next(self.parent.glob(".sciretriever-output-*.backup"))
                replacement = self.parent / "backup-replacement"
                replacement.write_bytes(b"backup evidence")
                os.chmod(replacement, 0o600)
                os.replace(replacement, backup)

        with self.assertRaises(AtomicOutputError):
            write_atomic(
                self.target,
                self.payload,
                overwrite=True,
                failpoint=replace_private_backup,
            )
        self.assertEqual(self.target.read_bytes(), self.old_payload)
        self.assertEqual(
            sum(
                path.is_file() and path.read_bytes() == b"backup evidence"
                for path in self.parent.iterdir()
            ),
            1,
        )

        self._write_old()

        def replace_private_stage(name: str) -> None:
            if name == "after-publish":
                stage = next(self.parent.glob(".sciretriever-output-*.staging"))
                replacement = self.parent / "stage-replacement"
                replacement.write_bytes(b"stage evidence")
                os.chmod(replacement, 0o600)
                os.replace(replacement, stage)

        with self.assertRaises(AtomicOutputError):
            write_atomic(
                self.target,
                self.payload,
                overwrite=True,
                failpoint=replace_private_stage,
            )
        self.assertEqual(self.target.read_bytes(), self.old_payload)
        self.assertEqual(
            sum(
                path.is_file() and path.read_bytes() == b"stage evidence"
                for path in self.parent.iterdir()
            ),
            1,
        )

    def test_failed_recovery_returns_stable_error_and_preserves_evidence(self) -> None:
        self._write_old()
        real_exchange = output_module._renameat2_exchange
        calls = 0

        def fail_recovery(parent: int, left: str, right: str) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("injected recovery failure")
            real_exchange(parent, left, right)

        def fail_after_publish(name: str) -> None:
            if name == "after-publish":
                raise RuntimeError("injected publication failure")

        with mock.patch.object(output_module, "_renameat2_exchange", side_effect=fail_recovery):
            with self.assertRaises(AtomicOutputError) as caught:
                write_atomic(
                    self.target,
                    self.payload,
                    overwrite=True,
                    failpoint=fail_after_publish,
                )
        self.assertEqual(str(caught.exception), "atomic output publication failed")
        evidence = tuple(
            path
            for path in self.parent.iterdir()
            if path.is_file() and path.read_bytes() == self.old_payload
        )
        self.assertGreaterEqual(len(evidence), 1)

    def test_cross_filesystem_publish_fallback_is_rejected(self) -> None:
        self._write_old()
        with mock.patch.object(
            output_module,
            "_renameat2_exchange",
            side_effect=OSError(getattr(os, "EXDEV", 18), "cross-device"),
        ):
            with self.assertRaises(AtomicOutputError):
                write_atomic(self.target, self.payload, overwrite=True)
        self.assertEqual(self.target.read_bytes(), self.old_payload)
        self.assertEqual(self._staging_entries(), ())


if __name__ == "__main__":
    unittest.main()
