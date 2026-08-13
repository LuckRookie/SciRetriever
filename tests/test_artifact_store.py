from __future__ import annotations

import io
import os
import stat
import threading
import unittest
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import sciretriever.storage.files.paths as paths_module
from sciretriever.model.primitives import RelativeArtifactPath, Sha256, sha256_digest
from sciretriever.storage.files.paths import StoragePathError, StorageRoot
from sciretriever.storage.files.reader import VerifiedReader, VerifiedReaderError
from sciretriever.storage.files.store import (
    ArtifactConflictError,
    ArtifactIntegrityError,
    ArtifactReference,
    ArtifactStore,
    ArtifactStoreError,
)


class ArtifactStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-artifact-store-")
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)
        os.chmod(self.parent, 0o700)
        self.root = StorageRoot(self.parent / "store")
        self.store = ArtifactStore(self.root, max_artifact_bytes=64)
        self.reader = VerifiedReader(self.root, max_artifact_bytes=64)

    @staticmethod
    def _content(label: str = "artifact") -> bytes:
        return f"opaque {label}".encode("ascii")

    def publish(
        self,
        content: bytes,
        *,
        media_type: str = "application/octet-stream",
        stream: bool = False,
        store: ArtifactStore | None = None,
    ) -> ArtifactReference:
        source: bytes | io.BytesIO = io.BytesIO(content) if stream else content
        target_store = self.store if store is None else store
        return target_store.publish(
            source,
            sha256=sha256_digest(content),
            byte_size=len(content),
            media_type=media_type,
        )

    def target_path(self, reference: ArtifactReference) -> Path:
        return self.root.canonical_path / str(reference.path)

    def test_boundary_errors_ignore_custom_messages(self) -> None:
        marker = "secret-root=/private/storage token=do-not-leak"
        expected = (
            (ArtifactStoreError, "artifact store operation failed"),
            (ArtifactIntegrityError, "artifact bytes do not match expected identity"),
            (ArtifactConflictError, "artifact target conflicts with existing object"),
            (VerifiedReaderError, "verified artifact read failed"),
        )
        for error_type, expected_message in expected:
            with self.subTest(error_type=error_type.__name__):
                error = error_type(marker)
                self.assertEqual(str(error), expected_message)
                self.assertNotIn(marker, str(error))

    def test_publish_verifies_expected_identity_without_business_format_rules(self) -> None:
        content = b"this is intentionally not a PDF or Markdown document"
        reference = self.publish(content, media_type="application/pdf", stream=True)

        self.assertIsInstance(reference, ArtifactReference)
        self.assertIsInstance(reference.sha256, Sha256)
        self.assertEqual(reference.sha256, sha256_digest(content))
        self.assertEqual(reference.byte_size, len(content))
        self.assertEqual(reference.media_type, "application/pdf")
        self.assertFalse(Path(str(reference.path)).is_absolute())
        self.assertNotIn(str(self.root.canonical_path), str(reference.path))
        target = self.target_path(reference)
        self.assertEqual(target.read_bytes(), content)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        self.assertEqual(target.stat().st_nlink, 1)

    def test_empty_and_oversized_source_are_rejected_and_staging_is_clean(self) -> None:
        with self.assertRaises(ArtifactIntegrityError):
            self.store.publish(
                b"",
                sha256=sha256_digest(b""),
                byte_size=0,
                media_type="application/octet-stream",
            )
        oversized = b"x" * 65
        with self.assertRaises(ArtifactIntegrityError):
            self.store.publish(
                oversized,
                sha256=sha256_digest(oversized),
                byte_size=len(oversized),
                media_type="application/octet-stream",
            )
        staging = self.root.canonical_path / ".staging"
        self.assertTrue(not staging.exists() or tuple(staging.iterdir()) == ())
        self.assertFalse((self.root.canonical_path / ".objects").exists())

    def test_expected_size_hash_and_media_inputs_are_validated_before_publication(self) -> None:
        content = self._content()
        digest = sha256_digest(content)
        cases = (
            {"sha256": Sha256("b" * 64), "byte_size": len(content)},
            {"sha256": digest, "byte_size": len(content) + 1},
            {"sha256": digest, "byte_size": len(content), "media_type": "  "},
        )
        for values in cases:
            with self.subTest(values=values):
                kwargs: dict[str, object] = {
                    "sha256": values["sha256"],
                    "byte_size": values["byte_size"],
                    "media_type": values.get("media_type", "application/octet-stream"),
                }
                with self.assertRaises(ArtifactIntegrityError):
                    self.store.publish(content, **kwargs)  # type: ignore[arg-type]
        self.assertFalse((self.root.canonical_path / ".objects").exists())

    def test_replay_of_identical_bytes_reuses_one_formal_object(self) -> None:
        content = self._content("replay")
        first = self.publish(content)
        second = self.publish(content, stream=True)

        self.assertEqual(first, second)
        target = self.target_path(first)
        self.assertEqual(target.read_bytes(), content)
        self.assertEqual(target.stat().st_nlink, 1)
        self.assertEqual(
            tuple(path for path in target.parent.iterdir() if path.is_file()),
            (target,),
        )
        self.assertEqual(tuple((self.root.canonical_path / ".staging").iterdir()), ())

    def test_existing_different_bytes_are_preserved_as_conflict_evidence(self) -> None:
        content = self._content("conflict")
        reference = self.publish(content)
        target = self.target_path(reference)
        target.unlink()
        evidence = b"different bytes at the same content address"
        target.write_bytes(evidence)
        os.chmod(target, 0o600)

        with self.assertRaises(ArtifactConflictError):
            self.publish(content)

        self.assertEqual(target.read_bytes(), evidence)
        self.assertEqual(tuple((self.root.canonical_path / ".staging").iterdir()), ())

    def test_existing_hardlink_and_symlink_targets_are_preserved_and_rejected(self) -> None:
        hardlink_content = self._content("hardlink")
        hardlink_reference = self.publish(hardlink_content)
        hardlink_target = self.target_path(hardlink_reference)
        alias = self.parent / "hardlink-alias"
        os.link(hardlink_target, alias)
        with self.assertRaises(ArtifactConflictError):
            self.publish(hardlink_content)
        self.assertEqual(hardlink_target.stat().st_nlink, 2)
        alias.unlink()

        symlink_content = self._content("symlink")
        symlink_reference = self.publish(symlink_content)
        symlink_target = self.target_path(symlink_reference)
        evidence = self.parent / "symlink-evidence"
        evidence.write_bytes(b"preserved evidence")
        os.chmod(evidence, 0o600)
        symlink_target.unlink()
        symlink_target.symlink_to(evidence)
        with self.assertRaises(ArtifactConflictError):
            self.publish(symlink_content)
        self.assertTrue(symlink_target.is_symlink())
        symlink_target.unlink()

    def test_concurrent_create_if_absent_publication_is_unique_and_idempotent(self) -> None:
        content = self._content("concurrent")
        results: list[ArtifactReference] = []
        errors: list[BaseException] = []
        lock = threading.Lock()

        def worker() -> None:
            try:
                result = self.publish(content, stream=True)
                with lock:
                    results.append(result)
            except BaseException as error:  # pragma: no cover - assertion below reports it.
                with lock:
                    errors.append(error)

        threads = [threading.Thread(target=worker) for _ in range(16)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(errors, [])
        self.assertEqual(len(results), len(threads))
        self.assertEqual(set(results), {results[0]})
        self.assertEqual(self.target_path(results[0]).stat().st_nlink, 1)
        self.assertEqual(tuple((self.root.canonical_path / ".staging").iterdir()), ())

    def test_publication_failpoints_never_overwrite_and_cleanup_staging(self) -> None:
        for checkpoint in (
            "after-stage-fsync",
            "after-publish",
            "after-directory-fsync",
            "after-cleanup",
        ):
            with self.subTest(checkpoint=checkpoint):
                root = StorageRoot(self.parent / f"failpoint-{checkpoint}")
                store = ArtifactStore(root, max_artifact_bytes=64)
                content = self._content(checkpoint)

                def failpoint(name: str, expected: str = checkpoint) -> None:
                    if name == expected:
                        raise RuntimeError("publication fault")

                with self.assertRaises(ArtifactStoreError):
                    store.publish(
                        content,
                        sha256=sha256_digest(content),
                        byte_size=len(content),
                        media_type="application/octet-stream",
                        checkpoint=failpoint,
                    )
                staging_directory = root.canonical_path / ".staging"
                self.assertEqual(tuple(staging_directory.iterdir()), ())
                objects = root.canonical_path / ".objects"
                formal = list(objects.rglob("*")) if objects.exists() else []
                if checkpoint == "after-stage-fsync":
                    self.assertEqual(formal, [])
                else:
                    files = [path for path in formal if path.is_file()]
                    self.assertEqual(len(files), 1)
                    self.assertEqual(files[0].read_bytes(), content)

    def test_linked_stage_cleanup_preserves_replacement_after_last_identity_check(self) -> None:
        content = self._content("linked-stage-race")
        replacement = self.parent / "linked-stage-replacement"
        real_move = paths_module._rename_noreplace

        def replace_before_quarantine(parent: int, source: str, destination: str) -> None:
            stage_paths = tuple((self.root.canonical_path / ".staging").iterdir())
            self.assertEqual(len(stage_paths), 1)
            replacement.write_bytes(b"linked-stage replacement evidence")
            os.chmod(replacement, 0o600)
            os.replace(replacement, stage_paths[0])
            real_move(parent, source, destination)

        with mock.patch.object(
            paths_module,
            "_rename_noreplace",
            side_effect=replace_before_quarantine,
        ):
            with self.assertRaises(ArtifactConflictError):
                self.publish(content)

        evidence = tuple(
            path
            for path in (self.root.canonical_path / ".staging").iterdir()
            if path.is_file() and path.read_bytes() == b"linked-stage replacement evidence"
        )
        self.assertEqual(len(evidence), 1)
        objects = list((self.root.canonical_path / ".objects").rglob("*"))
        formal = [path for path in objects if path.is_file()]
        self.assertEqual(len(formal), 1)
        self.assertEqual(formal[0].read_bytes(), content)

    def test_keyboard_interrupt_preserves_publication_commit_windows(self) -> None:
        for checkpoint, should_publish in (
            ("after-stage-fsync", False),
            ("after-publish", True),
        ):
            with self.subTest(checkpoint=checkpoint):
                root = StorageRoot(self.parent / f"keyboard-{checkpoint}")
                store = ArtifactStore(root, max_artifact_bytes=64)
                content = self._content(f"keyboard-{checkpoint}")
                marker = KeyboardInterrupt(checkpoint)

                def failpoint(name: str) -> None:
                    if name == checkpoint:
                        raise marker

                with self.assertRaises(KeyboardInterrupt) as caught:
                    store.publish(
                        content,
                        sha256=sha256_digest(content),
                        byte_size=len(content),
                        media_type="application/octet-stream",
                        checkpoint=failpoint,
                    )
                self.assertIs(caught.exception, marker)
                staging = root.canonical_path / ".staging"
                self.assertEqual(tuple(staging.iterdir()), ())
                objects = root.canonical_path / ".objects"
                formal = [path for path in objects.rglob("*") if path.is_file()]
                if should_publish:
                    self.assertEqual(len(formal), 1)
                    self.assertEqual(formal[0].read_bytes(), content)
                else:
                    self.assertEqual(formal, [])


class VerifiedReaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-verified-reader-")
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)
        os.chmod(self.parent, 0o700)
        self.root = StorageRoot(self.parent / "store")
        self.store = ArtifactStore(self.root, max_artifact_bytes=64)
        self.reader = VerifiedReader(self.root, max_artifact_bytes=64)
        self.content = b"reader bytes"
        self.reference = self.store.publish(
            self.content,
            sha256=sha256_digest(self.content),
            byte_size=len(self.content),
            media_type="application/octet-stream",
        )
        self.target = self.root.canonical_path / str(self.reference.path)

    def test_context_managed_reader_verifies_and_closes_binary_stream(self) -> None:
        with self.reader.open(self.reference) as stream:
            self.assertEqual(stream.read(), self.content)
            self.assertFalse(stream.closed)
        self.assertTrue(stream.closed)

    def test_registration_lease_requires_store_publication_and_is_not_reusable_after_close(
        self,
    ) -> None:
        manual = ArtifactReference(
            path=self.reference.path,
            sha256=self.reference.sha256,
            byte_size=self.reference.byte_size,
            media_type=self.reference.media_type,
        )
        with self.assertRaises(VerifiedReaderError):
            self.reader.acquire(manual)

        lease = self.reader.acquire(self.reference)
        lease.close()
        with self.assertRaises(VerifiedReaderError):
            lease.prepare_registration()
        with self.assertRaises(VerifiedReaderError):
            lease.verify_registration()

    def test_registration_lease_detects_named_object_mutation_without_rehashing(self) -> None:
        with self.reader.acquire(self.reference) as lease:
            self.target.write_bytes(b"changed reader bytes")
            os.chmod(self.target, 0o600)
            with self.assertRaises(VerifiedReaderError):
                lease.verify_registration()

    def test_reader_accepts_raw_relative_reference_only_with_expected_fields(self) -> None:
        with self.reader.open(
            self.reference.path,
            sha256=self.reference.sha256,
            byte_size=self.reference.byte_size,
            media_type=self.reference.media_type,
        ) as stream:
            self.assertEqual(stream.read(), self.content)
        with self.assertRaises(VerifiedReaderError):
            self.reader.open(self.reference.path)

    def test_reader_rejects_size_hash_and_media_mismatch_without_path_leak(self) -> None:
        for changes in (
            {"sha256": Sha256("b" * 64)},
            {"byte_size": self.reference.byte_size + 1},
        ):
            with self.subTest(changes=changes):
                changed = replace(self.reference, **changes)
                with self.assertRaises(VerifiedReaderError) as caught:
                    self.reader.open(changed)
                self.assertNotIn(str(self.root.canonical_path), str(caught.exception))
        with self.assertRaises(VerifiedReaderError) as caught:
            self.reader.open(self.reference, media_type="text/plain")
        self.assertNotIn(str(self.root.canonical_path), str(caught.exception))
        # Media type is an expected descriptor supplied by the caller; the
        # reader does not sniff bytes or invent a second media-type fact.
        changed_media = replace(self.reference, media_type="text/plain")
        with self.reader.open(changed_media) as stream:
            self.assertEqual(stream.read(), self.content)

    def test_reader_rejects_escape_symlink_hardlink_and_nonregular_targets(self) -> None:
        for replacement in ("escape", "symlink", "hardlink", "directory"):
            with self.subTest(replacement=replacement):
                if replacement == "escape":
                    reference: RelativeArtifactPath | str = "../outside"
                else:
                    reference = self.reference.path
                    if replacement == "symlink":
                        evidence = self.parent / "reader-symlink-evidence"
                        evidence.write_bytes(self.content)
                        os.chmod(evidence, 0o600)
                        self.target.unlink()
                        self.target.symlink_to(evidence)
                    elif replacement == "hardlink":
                        alias = self.parent / "reader-hardlink-alias"
                        os.link(self.target, alias)
                    elif replacement == "directory":
                        self.target.unlink()
                        self.target.mkdir(mode=0o700)
                with self.assertRaises((VerifiedReaderError, StoragePathError)):
                    self.reader.open(
                        reference,
                        sha256=self.reference.sha256,
                        byte_size=self.reference.byte_size,
                        media_type=self.reference.media_type,
                    )
                if replacement == "symlink":
                    self.target.unlink()
                elif replacement == "hardlink":
                    (self.parent / "reader-hardlink-alias").unlink()
                elif replacement == "directory":
                    self.target.rmdir()
                if replacement != "escape":
                    self.target.write_bytes(self.content)
                    os.chmod(self.target, 0o600)

    def test_reader_detects_replacement_while_stream_is_open(self) -> None:
        replacement = self.parent / "reader-replacement"
        replacement.write_bytes(b"replacement bytes")
        os.chmod(replacement, 0o600)

        with self.assertRaises(VerifiedReaderError):
            with self.reader.open(self.reference) as stream:
                self.assertEqual(stream.read(), self.content)
                self.target.unlink()
                replacement.rename(self.target)

    def test_reader_rejects_in_place_content_change_on_context_exit(self) -> None:
        with self.assertRaises(VerifiedReaderError):
            with self.reader.open(self.reference) as stream:
                self.assertEqual(stream.read(), self.content)
                self.target.write_bytes(b"changed in place")
                os.chmod(self.target, 0o600)


if __name__ == "__main__":
    unittest.main()
