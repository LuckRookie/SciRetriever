from __future__ import annotations

import os
import stat
import subprocess
import sys
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import sciretriever.storage.files.paths as paths_module
import sciretriever.storage.files.staging as staging_module
from sciretriever.model.primitives import RelativeArtifactPath, Sha256
from sciretriever.storage.files.paths import (
    StoragePathError,
    StorageRoot,
    content_addressed_reference,
)
from sciretriever.storage.files.staging import StagingError, create_staging


class StoragePathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-storage-paths-")
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)
        os.chmod(self.parent, 0o700)
        self.root_path = self.parent / "private-root"

    def bind_root(self) -> StorageRoot:
        return StorageRoot(self.root_path)

    def test_root_is_canonical_directory_with_restrictive_creation_default(self) -> None:
        root = self.bind_root()

        self.assertTrue(root.canonical_path.is_absolute())
        metadata = self.root_path.lstat()
        self.assertTrue(stat.S_ISDIR(metadata.st_mode))
        self.assertFalse(stat.S_ISLNK(metadata.st_mode))
        self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o700)

    def test_paths_expose_only_canonical_public_names(self) -> None:
        removed = (
            "PathSecurityError",
            "StorageFilesystemError",
            "bind_storage_root",
            "validate_relative_reference",
            "resolve_relative_reference",
            "content_addressed_path",
        )
        for name in removed:
            with self.subTest(name=name):
                self.assertFalse(hasattr(paths_module, name))
        self.assertFalse(hasattr(StorageRoot, "bind"))
        self.assertFalse(hasattr(StorageRoot, "path"))
        self.assertFalse(hasattr(StorageRoot, "validate_reference"))
        self.assertEqual(
            set(paths_module.__all__),
            {"ReferenceKind", "StoragePathError", "StorageRoot", "content_addressed_reference"},
        )

    def test_existing_root_permissions_do_not_control_admission(self) -> None:
        self.root_path.mkdir()
        os.chmod(self.root_path, 0o777)

        root = StorageRoot(self.root_path)

        self.assertEqual(root.canonical_path, self.root_path)

    def test_symlink_and_nondirectory_ancestor_are_rejected(self) -> None:
        target = self.parent / "target"
        target.mkdir()
        symlink_parent = self.parent / "symlink-parent"
        symlink_parent.symlink_to(target, target_is_directory=True)
        with self.assertRaises(StoragePathError):
            StorageRoot(symlink_parent / "root")

        file_parent = self.parent / "file-parent"
        file_parent.write_bytes(b"not a directory")
        with self.assertRaises(StoragePathError):
            StorageRoot(file_parent / "root")

    def test_group_and_world_writable_ancestors_do_not_control_admission(self) -> None:
        group_writable = self.parent / "group-writable"
        world_writable = group_writable / "world-writable"
        world_writable.mkdir(parents=True)
        os.chmod(group_writable, 0o775)
        os.chmod(world_writable, 0o777)

        root = StorageRoot(world_writable / "root")

        self.assertEqual(root.canonical_path, world_writable / "root")

    def test_replaced_root_or_ancestor_fails_closed(self) -> None:
        root = self.bind_root()
        replacement = self.parent / "replacement"
        replacement.mkdir()
        old_root = self.parent / "old-root"
        self.root_path.rename(old_root)
        self.root_path.symlink_to(replacement, target_is_directory=True)
        with self.assertRaises(StoragePathError):
            with root.open_root():
                pass

        ancestor = self.parent / "ancestor"
        nested = ancestor / "nested"
        nested.mkdir(parents=True)
        os.chmod(ancestor, 0o700)
        os.chmod(nested, 0o700)
        nested_root = StorageRoot(nested)
        moved_ancestor = self.parent / "moved-ancestor"
        ancestor.rename(moved_ancestor)
        alternate = self.parent / "alternate-ancestor"
        alternate.mkdir()
        (self.parent / "ancestor").symlink_to(alternate, target_is_directory=True)
        with self.assertRaises(StoragePathError):
            with nested_root.open_root():
                pass

    def test_relative_reference_returns_only_normalized_relative_value(self) -> None:
        root = self.bind_root()
        object_directory = self.root_path / "objects"
        object_directory.mkdir(mode=0o700)
        object_path = object_directory / "item"
        object_path.write_bytes(b"payload")
        os.chmod(object_path, 0o600)

        reference = root.resolve("objects/item", kind="file")

        self.assertIsInstance(reference, RelativeArtifactPath)
        self.assertEqual(str(reference), "objects/item")
        self.assertFalse(Path(str(reference)).is_absolute())
        self.assertNotIn(str(self.root_path), str(reference))

    def test_invalid_relative_references_are_rejected_without_echoing_input(self) -> None:
        root = self.bind_root()
        invalid = (
            "",
            ".",
            "./item",
            "objects//item",
            "objects/./item",
            "objects/../item",
            "../outside",
            "/absolute/item",
            "//server/item",
            r"objects\item",
            r"C:\\outside",
            "C:/outside",
        )
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(StoragePathError) as context:
                    root.resolve(value, kind="file")
                if value:
                    self.assertNotIn(value, str(context.exception))
                self.assertNotIn(str(self.root_path), str(context.exception))

    def test_root_escape_symlink_nonregular_and_hardlink_are_rejected(self) -> None:
        root = self.bind_root()
        outside = self.parent / "outside"
        outside.mkdir()
        (outside / "secret").write_bytes(b"secret")
        os.chmod(outside / "secret", 0o600)
        (self.root_path / "escape").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(StoragePathError):
            root.resolve("escape/secret", kind="file")

        directory = self.root_path / "directory"
        directory.mkdir(mode=0o700)
        with self.assertRaises(StoragePathError):
            root.resolve("directory", kind="file")

        file_path = self.root_path / "file"
        file_path.write_bytes(b"x")
        os.chmod(file_path, 0o600)
        with self.assertRaises(StoragePathError):
            root.resolve("file", kind="directory")

        alias = self.root_path / "alias"
        os.link(file_path, alias)
        os.chmod(alias, 0o600)
        with self.assertRaises(StoragePathError):
            root.resolve("file", kind="file")

    def test_relative_reference_is_rechecked_after_root_replacement(self) -> None:
        root = self.bind_root()
        objects = self.root_path / "objects"
        objects.mkdir(mode=0o700)
        item = objects / "item"
        item.write_bytes(b"payload")
        os.chmod(item, 0o600)
        self.root_path.rename(self.parent / "old-root")
        replacement = self.parent / "replacement"
        replacement.mkdir()
        self.root_path.symlink_to(replacement, target_is_directory=True)

        with self.assertRaises(StoragePathError):
            root.resolve("objects/item", kind="file")

    def test_unlink_relative_preserves_replacement_in_quarantine(self) -> None:
        root = self.bind_root()
        target = self.root_path / "temporary"
        target.write_bytes(b"temporary bytes")
        os.chmod(target, 0o600)
        replacement = self.parent / "replacement"

        real_move = paths_module._rename_noreplace

        def replace_before_quarantine(parent: int, source: str, destination: str) -> None:
            replacement.write_bytes(b"replacement evidence")
            os.chmod(replacement, 0o600)
            os.replace(replacement, target)
            real_move(parent, source, destination)

        with mock.patch.object(
            paths_module,
            "_rename_noreplace",
            side_effect=replace_before_quarantine,
        ):
            with self.assertRaises(StoragePathError):
                root.unlink_relative("temporary")

        evidence = tuple(
            path
            for path in self.root_path.iterdir()
            if path.is_file() and path.read_bytes() == b"replacement evidence"
        )
        self.assertEqual(len(evidence), 1)
        self.assertFalse(target.exists())

    def test_descriptor_relative_open_does_not_follow_symlink(self) -> None:
        root = self.bind_root()
        directory = self.root_path / "objects"
        directory.mkdir(mode=0o700)
        item = directory / "item"
        item.write_bytes(b"payload")
        os.chmod(item, 0o600)

        with root.open_relative("objects/item", kind="file") as descriptor:
            self.assertEqual(os.read(descriptor, 100), b"payload")

        item.unlink()
        item.symlink_to(self.parent / "missing")
        with self.assertRaises(StoragePathError):
            with root.open_relative("objects/item", kind="file"):
                pass

    def test_content_addressed_reference_is_media_neutral_and_deterministic(self) -> None:
        digest = "a" * 64
        first = content_addressed_reference(digest, 12)
        second = content_addressed_reference(Sha256(digest), 12)
        different_size = content_addressed_reference(digest, 13)
        different_digest = content_addressed_reference("b" * 64, 12)

        self.assertEqual(first, second)
        self.assertEqual(str(first), str(first).replace("\\", "/"))
        self.assertFalse(Path(str(first)).is_absolute())
        self.assertNotEqual(first, different_size)
        self.assertNotEqual(first, different_digest)
        self.assertTrue(str(first).endswith("-12"))

    def test_content_addressed_reference_rejects_non_string_or_invalid_sha256_values(self) -> None:
        with self.assertRaises(StoragePathError):
            content_addressed_reference(object(), 1)  # type: ignore[arg-type]
        with self.assertRaises(StoragePathError):
            content_addressed_reference(123, 1)  # type: ignore[arg-type]
        invalid_sha256 = Sha256.model_construct(root="A" * 64)
        with self.assertRaises(StoragePathError):
            content_addressed_reference(invalid_sha256, 1)

    def test_content_addressed_reference_rejects_invalid_identity(self) -> None:
        with self.assertRaises(StoragePathError):
            content_addressed_reference("A" * 64, 1)
        with self.assertRaises(StoragePathError):
            content_addressed_reference("a" * 63, 1)
        with self.assertRaises(StoragePathError):
            content_addressed_reference("a" * 64, -1)
        with self.assertRaises(StoragePathError):
            content_addressed_reference("a" * 64, True)


class StagingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-storage-staging-")
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)
        os.chmod(self.parent, 0o700)
        self.root_path = self.parent / "private-root"
        self.root = StorageRoot(self.root_path)

    def test_staging_is_owner_only_random_and_cleaned_on_success(self) -> None:
        reference: RelativeArtifactPath | None = None
        with create_staging(self.root) as staging:
            reference = staging.reference
            self.assertIsInstance(reference, RelativeArtifactPath)
            self.assertFalse(Path(str(reference)).is_absolute())
            self.assertNotIn(str(self.root_path), str(reference))
            name = str(reference).rsplit("/", 1)[-1]
            self.assertTrue(name.startswith("stage-"))
            for sensitive in ("literature", "doi", "provider", "secret"):
                self.assertNotIn(sensitive, name.casefold())
            staging.write(b"staged bytes")
            staging.flush()
            with self.root.open_relative(reference, kind="file") as descriptor:
                metadata = os.fstat(descriptor)
                self.assertEqual(metadata.st_uid, os.geteuid())
                self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o600)
                self.assertEqual(os.read(descriptor, 100), b"staged bytes")

        if reference is None:
            self.fail("staging did not return a reference")
        with self.assertRaises(StoragePathError):
            self.root.resolve(reference, kind="file")
        staging_directory = self.root_path / ".staging"
        self.assertTrue(staging_directory.is_dir())
        self.assertEqual(tuple(staging_directory.iterdir()), ())

    def test_staging_exception_is_cleaned_and_does_not_clean_formal_objects(self) -> None:
        formal = self.root_path / "formal"
        formal.mkdir(mode=0o700)
        formal_file = formal / "object"
        formal_file.write_bytes(b"formal")
        os.chmod(formal_file, 0o600)

        with self.assertRaisesRegex(RuntimeError, "expected"):
            with create_staging(self.root) as staging:
                staging.write(b"temporary")
                raise RuntimeError("expected")

        self.assertEqual(formal_file.read_bytes(), b"formal")
        self.assertEqual(tuple((self.root_path / ".staging").iterdir()), ())

    def test_staging_names_are_unique_under_concurrency(self) -> None:
        references: list[str] = []
        errors: list[BaseException] = []
        lock = threading.Lock()

        def worker() -> None:
            try:
                with create_staging(self.root) as staging:
                    reference = str(staging.reference)
                    staging.write(b"x")
                    with lock:
                        references.append(reference)
            except BaseException as error:  # pragma: no cover - assertion below reports it.
                with lock:
                    errors.append(error)

        threads = [threading.Thread(target=worker) for _ in range(32)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(errors, [])
        self.assertEqual(len(references), 32)
        self.assertEqual(len(set(references)), 32)
        self.assertEqual(tuple((self.root_path / ".staging").iterdir()), ())

    def test_staging_handoff_keeps_only_a_relative_reference_until_consumed(self) -> None:
        reference: RelativeArtifactPath | None = None
        with create_staging(self.root) as staging:
            staging.write(b"keep me")
            reference = staging.handoff()

        if reference is None:
            self.fail("staging handoff did not return a reference")
        with self.root.open_relative(reference, kind="file") as descriptor:
            self.assertEqual(os.read(descriptor, 100), b"keep me")
        self.root.unlink_relative(reference)
        with self.assertRaises(StoragePathError):
            self.root.resolve(reference, kind="file")

    def test_handoff_discard_removes_stage_while_stage_is_still_open(self) -> None:
        reference: RelativeArtifactPath | None = None
        staging = create_staging(self.root)
        with staging:
            staging.write(b"discard me")
            reference = staging.handoff()
            staging.discard()

        if reference is None:
            self.fail("staging handoff did not return a reference")
        with self.assertRaises(StoragePathError):
            self.root.resolve(reference, kind="file")
        self.assertEqual(tuple((self.root_path / ".staging").iterdir()), ())

    def test_staging_cleanup_preserves_replacement_after_last_identity_check(self) -> None:
        staging = create_staging(self.root)
        staging.write(b"staging bytes")
        stage_path = self.root_path / str(staging.reference)
        replacement = self.parent / "staging-replacement"
        real_move = paths_module._rename_noreplace

        def replace_before_quarantine(parent: int, source: str, destination: str) -> None:
            replacement.write_bytes(b"staging replacement evidence")
            os.chmod(replacement, 0o600)
            os.replace(replacement, stage_path)
            real_move(parent, source, destination)

        with mock.patch.object(
            paths_module,
            "_rename_noreplace",
            side_effect=replace_before_quarantine,
        ):
            with self.assertRaises(StagingError):
                staging.close()

        evidence = tuple(
            path
            for path in (self.root_path / ".staging").iterdir()
            if path.is_file() and path.read_bytes() == b"staging replacement evidence"
        )
        self.assertEqual(len(evidence), 1)
        self.assertFalse(stage_path.exists())

    def test_handoff_discard_preserves_replacement_after_last_identity_check(self) -> None:
        staging = create_staging(self.root)
        staging.write(b"handoff bytes")
        staging.handoff()
        stage_path = self.root_path / str(staging.reference)
        replacement = self.parent / "handoff-replacement"
        real_move = paths_module._rename_noreplace

        def replace_before_quarantine(parent: int, source: str, destination: str) -> None:
            replacement.write_bytes(b"handoff replacement evidence")
            os.chmod(replacement, 0o600)
            os.replace(replacement, stage_path)
            real_move(parent, source, destination)

        with mock.patch.object(
            paths_module,
            "_rename_noreplace",
            side_effect=replace_before_quarantine,
        ):
            with self.assertRaises(StagingError):
                staging.discard()

        evidence = tuple(
            path
            for path in (self.root_path / ".staging").iterdir()
            if path.is_file() and path.read_bytes() == b"handoff replacement evidence"
        )
        self.assertEqual(len(evidence), 1)
        self.assertFalse(stage_path.exists())

    def test_staging_exposes_only_canonical_public_names(self) -> None:
        staging = create_staging(self.root)
        try:
            for name in ("create_staging_file", "staging_file"):
                with self.subTest(module_name=name):
                    self.assertFalse(hasattr(staging_module, name))
            for name in ("relative_path", "name", "descriptor", "closed", "handed_off"):
                with self.subTest(name=name):
                    self.assertFalse(hasattr(staging, name))
        finally:
            staging.close()

    def test_staging_is_cleaned_at_normal_process_exit(self) -> None:
        script = (
            "from sciretriever.storage.files.paths import StorageRoot; "
            "from sciretriever.storage.files.staging import create_staging; "
            f"root=StorageRoot({str(self.root_path)!r}); "
            "stage=create_staging(root); stage.write(b'exit cleanup')"
        )
        result = subprocess.run(
            [sys.executable, "-c", script],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(tuple((self.root_path / ".staging").iterdir()), ())

    def test_staging_rejects_identity_change_before_handoff(self) -> None:
        with create_staging(self.root) as staging:
            staging.write(b"payload")
            reference = staging.reference
            path = self.root_path / str(reference)
            alias = self.parent / "alias"
            os.link(path, alias)
            with self.assertRaises(StagingError):
                staging.flush()
            alias.unlink()


if __name__ == "__main__":
    unittest.main()
