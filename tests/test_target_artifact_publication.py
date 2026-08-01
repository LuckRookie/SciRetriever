from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from sciretriever.content.model import ArtifactKind, StagedArtifact
from sciretriever.kernel import RelativeArtifactPath, Sha256
from sciretriever.literature_store.filesystem import (
    AdmissionConflictError,
    ArtifactConflictError,
    CoreArtifactReconciler,
    CoreArtifactStore,
    LocalAdmissionBindingFactory,
)
from sciretriever.literature_store.sqlite import create_or_open_catalog


class TargetArtifactPublicationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-artifacts-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)
        self.catalog = self.root / "catalog.sqlite"
        with create_or_open_catalog(self.catalog):
            pass
        self.storage = self.root / "storage"
        self.store = CoreArtifactStore(self.storage)

    @staticmethod
    def artifact(kind: ArtifactKind, content: bytes) -> StagedArtifact:
        return StagedArtifact(
            kind,
            RelativeArtifactPath("ignored/by/store"),
            Sha256.from_bytes(content),
            content,
        )

    def test_every_core_kind_publishes_and_exact_replay_is_stable(self) -> None:
        cases = (
            (ArtifactKind.PRIMARY_PDF, b"%PDF-1.7\nprimary"),
            (ArtifactKind.SUPPLEMENTARY, b"supplement"),
            (ArtifactKind.LIGHT_DOCUMENT, b'{"blocks":[]}'),
            (ArtifactKind.ANALYSIS, b'{"summary":"ok"}'),
        )
        for kind, content in cases:
            with self.subTest(kind=kind):
                first = self.store.publish(self.artifact(kind, content))
                second = self.store.publish(self.artifact(kind, content))
                target = self.storage / "core" / str(first.path)
                self.assertEqual(first, second)
                self.assertEqual(target.read_bytes(), content)
                self.assertEqual(first.size, len(content))
                self.assertEqual(stat_mode(target), 0o600)

    def test_mismatched_existing_target_is_preserved_as_conflict_evidence(self) -> None:
        artifact = self.artifact(ArtifactKind.PRIMARY_PDF, b"%PDF-valid")
        published = self.store.publish(artifact)
        target = self.storage / "core" / str(published.path)
        target.unlink()
        target.write_bytes(b"conflict")
        os.chmod(target, 0o600)

        with self.assertRaises(ArtifactConflictError):
            self.store.publish(artifact)

        self.assertEqual(target.read_bytes(), b"conflict")

    def test_existing_hardlinked_target_is_rejected_and_preserved(self) -> None:
        artifact = self.artifact(ArtifactKind.PRIMARY_PDF, b"%PDF-aliased-existing")
        digest = str(artifact.sha256)
        target = self.storage / "core" / "primary" / digest[:2] / digest
        target.parent.mkdir(parents=True, mode=0o700)
        for directory in (self.storage, self.storage / "core", target.parent.parent, target.parent):
            os.chmod(directory, 0o700)
        target.write_bytes(artifact.content)
        os.chmod(target, 0o600)
        alias = self.root / "external-alias"
        os.link(target, alias)

        with self.assertRaises(ArtifactConflictError):
            self.store.publish(artifact)

        self.assertEqual((target.read_bytes(), target.stat().st_nlink), (artifact.content, 2))

    def test_post_publication_hardlink_makes_replay_conflict(self) -> None:
        artifact = self.artifact(ArtifactKind.PRIMARY_PDF, b"%PDF-aliased-replay")
        published = self.store.publish(artifact)
        target = self.storage / "core" / str(published.path)
        os.link(target, self.root / "post-publication-alias")

        with self.assertRaises(ArtifactConflictError):
            self.store.publish(artifact)

        self.assertEqual(target.stat().st_nlink, 2)

    def test_reconciliation_preserves_malformed_and_corrupt_core_evidence(self) -> None:
        core = self.storage / "core" / "primary"
        malformed = core / "aa" / "not-a-sha256"
        wrong_prefix_digest = "b" * 64
        wrong_prefix = core / "aa" / wrong_prefix_digest
        valid_name_digest = "c" * 64
        wrong_bytes = core / "cc" / valid_name_digest
        for path, content in (
            (malformed, b"operator evidence"),
            (wrong_prefix, b"wrong prefix"),
            (wrong_bytes, b"wrong bytes"),
        ):
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            for directory in (self.storage, self.storage / "core", core, path.parent):
                os.chmod(directory, 0o700)
            path.write_bytes(content)
            os.chmod(path, 0o600)

        result = self.reconciler().reconcile()

        self.assertEqual(
            set(result.preserved),
            {
                RelativeArtifactPath("primary/aa/not-a-sha256"),
                RelativeArtifactPath(f"primary/aa/{wrong_prefix_digest}"),
                RelativeArtifactPath(f"primary/cc/{valid_name_digest}"),
            },
        )
        self.assertTrue(all(path.exists() for path in (malformed, wrong_prefix, wrong_bytes)))

    def test_reconciliation_rejects_regular_hardlink_and_symlink_replacements(self) -> None:
        replacements = ("regular", "hardlink", "symlink")
        for replacement in replacements:
            with self.subTest(replacement=replacement):
                artifact = self.artifact(
                    ArtifactKind.ANALYSIS,
                    f'{{"replacement":"{replacement}"}}'.encode("ascii"),
                )
                published = self.store.publish(artifact)
                target = self.storage / "core" / str(published.path)

                def replace(checkpoint: str) -> None:
                    if checkpoint != "after-scan":
                        return
                    target.unlink()
                    evidence = self.root / f"{replacement}-evidence"
                    evidence.write_bytes(b"replacement evidence")
                    os.chmod(evidence, 0o600)
                    if replacement == "regular":
                        target.write_bytes(b"replacement evidence")
                        os.chmod(target, 0o600)
                    elif replacement == "hardlink":
                        os.link(evidence, target)
                    else:
                        target.symlink_to(evidence)

                result = self.reconciler().reconcile(checkpoint=replace)

                self.assertEqual(result.deleted, ())
                self.assertEqual(result.preserved, (published.path,))
                self.assertTrue(target.exists())
                if target.is_symlink():
                    target.unlink()
                else:
                    target.unlink()

    def reconciler(self) -> CoreArtifactReconciler:
        bound = LocalAdmissionBindingFactory().bind_catalog(self.catalog)
        return CoreArtifactReconciler(
            self.storage, self.catalog, bound.port, bound.identity
        )

    def test_reconciliation_preserves_references_and_never_observes_extension_root(self) -> None:
        referenced = self.store.publish(self.artifact(ArtifactKind.PRIMARY_PDF, b"%PDF-shared"))
        orphan = self.store.publish(self.artifact(ArtifactKind.ANALYSIS, b'{"orphan":true}'))
        extension = self.storage / "extensions" / "package" / "private.bin"
        extension.parent.mkdir(parents=True, mode=0o700)
        extension.write_bytes(b"extension")
        os.chmod(extension, 0o000)
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute(
                "INSERT INTO artifacts(id,kind,sha256,storage_path,byte_size) VALUES ('kept','raw',?,?,?)",
                (str(referenced.sha256), str(referenced.path), referenced.size),
            )
            connection.commit()
        bound = LocalAdmissionBindingFactory().bind_catalog(self.catalog)
        result = CoreArtifactReconciler(
            self.storage, self.catalog, bound.port, bound.identity
        ).reconcile()

        self.assertEqual(result.deleted, (orphan.path,))
        self.assertTrue((self.storage / "core" / str(referenced.path)).exists())
        self.assertTrue(extension.exists())

    def test_publication_window_core_write_admission_blocks_reconciliation(self) -> None:
        bound = LocalAdmissionBindingFactory().bind_catalog(self.catalog)
        reconciler = CoreArtifactReconciler(
            self.storage, self.catalog, bound.port, bound.identity
        )

        with bound.port.acquire_core_write(bound.identity):
            published = self.store.publish(
                self.artifact(ArtifactKind.PRIMARY_PDF, b"%PDF-pending-reference")
            )
            with self.assertRaises(AdmissionConflictError):
                reconciler.reconcile()

        self.assertTrue((self.storage / "core" / str(published.path)).exists())

    def test_subprocess_interruptions_leave_only_safe_staging_or_reclaimable_objects(self) -> None:
        for checkpoint in (
            "after-stage-fsync",
            "after-publish",
            "after-directory-fsync",
            "after-cleanup",
        ):
            with self.subTest(checkpoint=checkpoint):
                content = f'{{"checkpoint":"{checkpoint}"}}'.encode("ascii")
                script = (
                    "import os; from pathlib import Path; "
                    "from sciretriever.content.model import ArtifactKind,StagedArtifact; "
                    "from sciretriever.kernel import RelativeArtifactPath,Sha256; "
                    "from sciretriever.literature_store.filesystem import CoreArtifactStore; "
                    f"data={content!r}; s=CoreArtifactStore(Path({str(self.storage)!r})); "
                    "s.publish(StagedArtifact(ArtifactKind.ANALYSIS,RelativeArtifactPath('x'),Sha256.from_bytes(data),data),checkpoint=lambda n: os._exit(73) if n=="
                    f"{checkpoint!r} else None)"
                )
                process = subprocess.run(
                    [sys.executable, "-c", script], check=False,
                    capture_output=True, text=True,
                )
                self.assertEqual(process.returncode, 73, process.stderr)
        bound = LocalAdmissionBindingFactory().bind_catalog(self.catalog)
        result = CoreArtifactReconciler(
            self.storage, self.catalog, bound.port, bound.identity
        ).reconcile()
        self.assertEqual(len(result.deleted), 3)
        staging = self.storage / "core" / ".staging"
        self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in staging.iterdir()))


def stat_mode(path: Path) -> int:
    return path.stat().st_mode & 0o777


if __name__ == "__main__":
    unittest.main()
