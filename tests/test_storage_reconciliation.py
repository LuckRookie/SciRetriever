from __future__ import annotations

import hashlib
import os
import sqlite3
import stat
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sciretriever.storage.files import paths as paths_module
from sciretriever.storage.files.paths import StorageRoot
from sciretriever.storage.files.reconciliation import (
    ArtifactReconciliationError,
    ArtifactStoreReconciler,
)
from sciretriever.storage.files.store import ArtifactReference, ArtifactStore
from sciretriever.storage.locking import CatalogLockConflictError, CatalogWriteLock
from sciretriever.storage.sqlite.artifact_references import SqliteArtifactReferenceStore
from sciretriever.storage.sqlite.engine import CatalogEngine


class _InjectedFailure(RuntimeError):
    pass


class StorageReconciliationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-reconciliation-")
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)
        os.chmod(self.parent, 0o700)
        self.catalog_path = self.parent / "catalog.sqlite"
        self.engine = CatalogEngine(self.catalog_path)
        self.storage_path = self.parent / "artifacts"
        self.root = StorageRoot(self.storage_path)
        self.artifacts = ArtifactStore(self.root)
        self.references = SqliteArtifactReferenceStore(self.engine)
        self.reconciler = ArtifactStoreReconciler(self.root, self.references)

    def _publish(
        self, payload: bytes, media_type: str = "application/octet-stream"
    ) -> ArtifactReference:
        return self.artifacts.publish(
            payload,
            sha256=hashlib.sha256(payload).hexdigest(),
            byte_size=len(payload),
            media_type=media_type,
        )

    def _artifact_file(self, reference: ArtifactReference) -> Path:
        return self.storage_path.joinpath(*reference.path.root.split("/"))

    def _insert_artifact(self, artifact_id: str, reference: ArtifactReference) -> None:
        with self.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,"
                "relative_path) VALUES(?,?,?,?,?)",
                (
                    artifact_id,
                    reference.sha256.root,
                    reference.byte_size,
                    reference.media_type,
                    reference.path.root,
                ),
            )

    def _artifact_rows(self) -> tuple[tuple[object, ...], ...]:
        with self.engine.read_snapshot() as connection:
            return tuple(
                tuple(row)
                for row in connection.execute(
                    "SELECT artifact_id,sha256,byte_size,media_type,relative_path "
                    "FROM artifact_objects ORDER BY relative_path"
                ).fetchall()
            )

    def _install_all_reference_faces(self) -> tuple[ArtifactReference, ...]:
        artifacts = (
            self._publish(b"asset-pdf", "application/pdf"),
            self._publish(b"parser-markdown", "text/markdown"),
            self._publish(b"parser-resource", "image/png"),
            self._publish(b"structured-content", "application/json"),
        )
        artifacts = (*artifacts, artifacts[1])
        metadata_sha256 = "a" * 64
        with self.engine.write_transaction() as connection:
            connection.executemany(
                "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,"
                "relative_path) VALUES(?,?,?,?,?)",
                tuple(
                    (
                        f"artifact-{index}",
                        artifact.sha256.root,
                        artifact.byte_size,
                        artifact.media_type,
                        artifact.path.root,
                    )
                    for index, artifact in enumerate(dict.fromkeys(artifacts))
                ),
            )
            connection.execute(
                "INSERT INTO meta_literatures(meta_literature_id,"
                "representative_literature_id) VALUES('meta-1','literature-1')"
            )
            connection.execute(
                "INSERT INTO literatures(literature_id,meta_literature_id,version_role) "
                "VALUES('literature-1','meta-1','published')"
            )
            connection.execute(
                "INSERT INTO literature_metadata(literature_id,metadata_revision,"
                "metadata_sha256,title) VALUES('literature-1',1,?,'Fixture')",
                (metadata_sha256,),
            )
            connection.executemany(
                "INSERT INTO provenances(provenance_id,source_kind,source_name,"
                "source_record_id,observed_at,input_sha256,parameters_sha256) "
                "VALUES(?,?,?,?,?,?,?)",
                (
                    (
                        "parser-provenance",
                        "parser",
                        "fixture-parser",
                        None,
                        "2026-08-12T00:00:00Z",
                        artifacts[0].sha256.root,
                        None,
                    ),
                    (
                        "analysis-provenance",
                        "analysis",
                        "fixture-analysis",
                        None,
                        "2026-08-12T00:00:00Z",
                        artifacts[1].sha256.root,
                        None,
                    ),
                ),
            )
            connection.execute(
                "INSERT INTO assets(asset_id,sha256,size_bytes,media_type,relative_path) "
                "VALUES('asset-1',?,?,?,?)",
                (
                    artifacts[0].sha256.root,
                    artifacts[0].byte_size,
                    artifacts[0].media_type,
                    artifacts[0].path.root,
                ),
            )
            connection.execute(
                "INSERT INTO parser_results(source_asset_id,source_sha256,result_sha256,"
                "page_count,markdown_artifact_path,markdown_sha256,markdown_byte_size,"
                "markdown_media_type,provenance_id,parser_version,mode,model_identity) "
                "VALUES('asset-1',?,?,1,?,?,?,?,'parser-provenance','fixture',NULL,NULL)",
                (
                    artifacts[0].sha256.root,
                    "b" * 64,
                    artifacts[1].path.root,
                    artifacts[1].sha256.root,
                    artifacts[1].byte_size,
                    artifacts[1].media_type,
                ),
            )
            connection.execute(
                "INSERT INTO parser_result_resources(source_asset_id,ordinal,reference,"
                "artifact_path,artifact_sha256,artifact_byte_size,artifact_media_type) "
                "VALUES('asset-1',0,'figure-1',?,?,?,?)",
                (
                    artifacts[2].path.root,
                    artifacts[2].sha256.root,
                    artifacts[2].byte_size,
                    artifacts[2].media_type,
                ),
            )
            connection.execute(
                "INSERT INTO literature_contents(literature_id,literature_content_sha256,"
                "metadata_revision,metadata_sha256,primary_asset_id,primary_asset_sha256,"
                "parser_result_sha256,structured_artifact_path,structured_artifact_sha256,"
                "structured_artifact_byte_size,structured_artifact_media_type,"
                "markdown_artifact_path,markdown_artifact_sha256,markdown_artifact_byte_size,"
                "markdown_artifact_media_type,analysis_provenance_id) "
                "VALUES('literature-1',?,1,?,'asset-1',?,?, ?,?,?,?, ?,?,?,?,"
                "'analysis-provenance')",
                (
                    "c" * 64,
                    metadata_sha256,
                    artifacts[0].sha256.root,
                    "b" * 64,
                    artifacts[3].path.root,
                    artifacts[3].sha256.root,
                    artifacts[3].byte_size,
                    artifacts[3].media_type,
                    artifacts[4].path.root,
                    artifacts[4].sha256.root,
                    artifacts[4].byte_size,
                    artifacts[4].media_type,
                ),
            )
        return artifacts

    def test_snapshot_enumerates_all_five_formal_reference_faces(self) -> None:
        artifacts = self._install_all_reference_faces()

        snapshot = self.references.snapshot()

        self.assertEqual(
            {reference.source for reference in snapshot.references},
            {
                "assets.relative_path",
                "parser_results.markdown_artifact_path",
                "parser_result_resources.artifact_path",
                "literature_contents.structured_artifact_path",
                "literature_contents.markdown_artifact_path",
            },
        )
        self.assertEqual(
            snapshot.referenced_paths,
            frozenset(artifact.path for artifact in artifacts),
        )

    def test_deletes_filesystem_only_and_unreferenced_catalog_objects(self) -> None:
        filesystem_only = self._publish(b"filesystem-only")
        row_backed = self._publish(b"row-backed")
        self._insert_artifact("unreferenced-row", row_backed)

        before = self.references.snapshot()
        self.assertEqual({item.path for item in before.objects}, {row_backed.path})
        self.assertEqual(before.referenced_paths, frozenset())

        result = self.reconciler.reconcile()

        self.assertEqual(
            result.deleted,
            tuple(sorted((filesystem_only.path, row_backed.path), key=lambda item: item.root)),
        )
        self.assertEqual(result.preserved, ())
        self.assertFalse(self._artifact_file(filesystem_only).exists())
        self.assertFalse(self._artifact_file(row_backed).exists())
        self.assertEqual(self._artifact_rows(), ())

        rerun = self.reconciler.reconcile()
        self.assertEqual(rerun.deleted, ())
        self.assertEqual(rerun.preserved, ())

    def test_every_formal_reference_preserves_the_shared_objects(self) -> None:
        artifacts = self._install_all_reference_faces()

        result = self.reconciler.reconcile()

        self.assertEqual(result.deleted, ())
        self.assertEqual(
            result.preserved,
            tuple(sorted({item.path for item in artifacts}, key=lambda item: item.root)),
        )
        self.assertTrue(all(self._artifact_file(item).is_file() for item in artifacts))
        self.assertEqual(len(self._artifact_rows()), 4)

    def test_schema_rejects_reference_media_conflict_mechanically(self) -> None:
        artifact = self._publish(b"media-conflict", "application/octet-stream")
        self._insert_artifact("media-conflict", artifact)

        with self.assertRaises(sqlite3.IntegrityError):
            with self.engine.write_transaction() as connection:
                connection.execute(
                    "INSERT INTO assets(asset_id,sha256,size_bytes,media_type,relative_path) "
                    "VALUES('conflicting-asset',?,?,?,?)",
                    (
                        artifact.sha256.root,
                        artifact.byte_size,
                        "application/pdf",
                        artifact.path.root,
                    ),
                )

        snapshot = self.references.snapshot()
        self.assertEqual(snapshot.references, ())
        self.assertEqual(len(snapshot.objects), 1)

    def test_staging_is_never_scanned_or_removed(self) -> None:
        stage_directory = self.storage_path / ".staging"
        stage_directory.mkdir(mode=0o700)
        stage = stage_directory / "active-stage"
        stage.write_bytes(b"active")
        os.chmod(stage, 0o600)

        result = self.reconciler.reconcile()

        self.assertEqual(result.deleted, ())
        self.assertEqual(stage.read_bytes(), b"active")

    def test_full_prevalidation_keeps_valid_orphan_when_any_catalog_file_is_missing(self) -> None:
        valid = self._publish(b"valid-orphan")
        self._insert_artifact("valid-orphan", valid)
        missing = self._publish(b"missing-catalog-object")
        self._insert_artifact("missing-object", missing)
        self._artifact_file(missing).unlink()
        before = self._artifact_rows()

        with self.assertRaises(ArtifactReconciliationError):
            self.reconciler.reconcile()

        self.assertTrue(self._artifact_file(valid).is_file())
        self.assertEqual(self._artifact_rows(), before)

    def test_noncanonical_path_hash_size_and_hardlink_fail_closed(self) -> None:
        cases = ("noncanonical", "hash", "size", "hardlink")
        for case in cases:
            with self.subTest(case=case):
                with TemporaryDirectory(prefix=f"sciretriever-reconciliation-{case}-") as name:
                    parent = Path(name)
                    os.chmod(parent, 0o700)
                    engine = CatalogEngine(parent / "catalog.sqlite")
                    root_path = parent / "artifacts"
                    root = StorageRoot(root_path)
                    store = ArtifactStore(root)
                    references = SqliteArtifactReferenceStore(engine)
                    reconciler = ArtifactStoreReconciler(root, references)
                    valid = store.publish(
                        b"candidate",
                        sha256=hashlib.sha256(b"candidate").hexdigest(),
                        byte_size=len(b"candidate"),
                        media_type="application/octet-stream",
                    )
                    valid_file = root_path.joinpath(*valid.path.root.split("/"))
                    with engine.write_transaction() as connection:
                        connection.execute(
                            "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,"
                            "media_type,relative_path) VALUES('candidate',?,?,?,?)",
                            (
                                valid.sha256.root,
                                valid.byte_size,
                                valid.media_type,
                                valid.path.root,
                            ),
                        )
                    if case == "noncanonical":
                        with engine.write_transaction() as connection:
                            connection.execute(
                                "UPDATE artifact_objects SET relative_path=? "
                                "WHERE artifact_id='candidate'",
                                (f".objects/ff/{valid.sha256.root}-{valid.byte_size}",),
                            )
                    elif case == "hash":
                        valid_file.write_bytes(b"tampered")
                        os.chmod(valid_file, 0o600)
                    elif case == "size":
                        valid_file.write_bytes(b"candidate-extra")
                        os.chmod(valid_file, 0o600)
                    else:
                        os.link(valid_file, parent / "extra-link")

                    with self.assertRaises(ArtifactReconciliationError):
                        reconciler.reconcile()

                    self.assertTrue(valid_file.exists())
                    with engine.read_snapshot() as connection:
                        self.assertEqual(
                            connection.execute("SELECT count(*) FROM artifact_objects").fetchone(),
                            (1,),
                        )

    def test_symlink_fifo_and_abnormal_objects_entries_fail_fast(self) -> None:
        cases = ("symlink", "fifo", "abnormal-prefix", "abnormal-name")
        for case in cases:
            with self.subTest(case=case):
                with TemporaryDirectory(prefix=f"sciretriever-reconciliation-{case}-") as name:
                    parent = Path(name)
                    os.chmod(parent, 0o700)
                    engine = CatalogEngine(parent / "catalog.sqlite")
                    root_path = parent / "artifacts"
                    root = StorageRoot(root_path)
                    store = ArtifactStore(root)
                    references = SqliteArtifactReferenceStore(engine)
                    reconciler = ArtifactStoreReconciler(root, references)
                    artifact = store.publish(
                        b"unsafe-entry",
                        sha256=hashlib.sha256(b"unsafe-entry").hexdigest(),
                        byte_size=len(b"unsafe-entry"),
                        media_type="application/octet-stream",
                    )
                    artifact_file = root_path.joinpath(*artifact.path.root.split("/"))
                    if case == "symlink":
                        artifact_file.unlink()
                        artifact_file.symlink_to(parent / "outside")
                    elif case == "fifo":
                        artifact_file.unlink()
                        os.mkfifo(artifact_file, 0o600)
                    elif case == "abnormal-prefix":
                        abnormal = root_path / ".objects" / "zz"
                        abnormal.mkdir(mode=0o700)
                    else:
                        abnormal = artifact_file.parent / "not-a-content-address"
                        abnormal.write_bytes(b"evidence")
                        os.chmod(abnormal, 0o600)

                    with self.assertRaisesRegex(
                        ArtifactReconciliationError,
                        r"^artifact store reconciliation (integrity check )?failed$",
                    ):
                        reconciler.reconcile()

                    self.assertTrue(artifact_file.exists() or artifact_file.is_symlink())
                    if case == "fifo":
                        self.assertTrue(stat.S_ISFIFO(os.lstat(artifact_file).st_mode))

    def test_artifact_permissions_do_not_control_reconciliation(self) -> None:
        artifact = self._publish(b"permissive-mode")
        artifact_file = self._artifact_file(artifact)
        os.chmod(self.storage_path, 0o777)
        os.chmod(artifact_file.parent.parent, 0o777)
        os.chmod(artifact_file.parent, 0o777)
        os.chmod(artifact_file, 0o666)

        result = self.reconciler.reconcile()

        self.assertEqual(result.deleted, (artifact.path,))
        self.assertFalse(artifact_file.exists())

    def test_identity_replacement_before_row_retirement_preserves_evidence(self) -> None:
        candidate = self._publish(b"replace-before-retirement")
        self._insert_artifact("replace-before-retirement", candidate)
        candidate_file = self._artifact_file(candidate)
        replacement = candidate_file.with_name(candidate_file.name + ".replacement")
        original_inode = candidate_file.stat().st_ino
        replaced = False

        def checkpoint(name: str) -> None:
            nonlocal replaced
            if name == "before-candidate-recheck" and not replaced:
                replacement.write_bytes(b"replace-before-retirement")
                os.chmod(replacement, 0o600)
                os.replace(replacement, candidate_file)
                replaced = True

        with self.assertRaisesRegex(
            ArtifactReconciliationError,
            r"^artifact store reconciliation integrity check failed$",
        ):
            self.reconciler.reconcile(checkpoint=checkpoint)

        self.assertTrue(candidate_file.is_file())
        self.assertNotEqual(candidate_file.stat().st_ino, original_inode)
        self.assertEqual(len(self._artifact_rows()), 1)

    def test_in_place_rewrite_before_quarantine_preserves_evidence(self) -> None:
        candidate = self._publish(b"original-orphan-bytes")
        candidate_file = self._artifact_file(candidate)
        original = candidate_file.stat()
        real_move = paths_module._rename_noreplace
        changed = False

        def rewrite_before_quarantine(parent: int, source: str, destination: str) -> None:
            nonlocal changed
            if not changed:
                with candidate_file.open("r+b", buffering=0) as stream:
                    stream.write(b"tampered-orphan-bytes")
                    stream.flush()
                    os.fsync(stream.fileno())
                os.utime(candidate_file, ns=(original.st_atime_ns, original.st_mtime_ns))
                self.assertNotEqual(candidate_file.stat().st_ctime_ns, original.st_ctime_ns)
                changed = True
            real_move(parent, source, destination)

        with patch.object(
            paths_module,
            "_rename_noreplace",
            side_effect=rewrite_before_quarantine,
        ):
            with self.assertRaisesRegex(
                ArtifactReconciliationError,
                r"^artifact store reconciliation integrity check failed$",
            ):
                self.reconciler.reconcile()

        evidence = tuple(
            path
            for path in candidate_file.parent.iterdir()
            if path.is_file() and path.read_bytes() == b"tampered-orphan-bytes"
        )
        self.assertEqual(len(evidence), 1)
        self.assertFalse(candidate_file.exists())

    def test_filesystem_only_is_rechecked_against_catalog_before_unlink(self) -> None:
        candidate = self._publish(b"filesystem-only-race")
        inserted = False

        def checkpoint(name: str) -> None:
            nonlocal inserted
            if name == "before-filesystem-only-confirm" and not inserted:
                self._insert_artifact("late-catalog-row", candidate)
                inserted = True

        result = self.reconciler.reconcile(checkpoint=checkpoint)

        self.assertEqual(result.deleted, ())
        self.assertEqual(result.preserved, (candidate.path,))
        self.assertTrue(self._artifact_file(candidate).is_file())
        self.assertEqual(len(self._artifact_rows()), 1)

    def test_unlink_os_failure_is_path_free_and_stops_later_candidates(self) -> None:
        first = self._publish(b"unlink-os-first")
        second = self._publish(b"unlink-os-second")
        self._insert_artifact("unlink-os-first", first)
        self._insert_artifact("unlink-os-second", second)
        ordered = sorted((first, second), key=lambda item: item.path.root)

        def fail_unlink(*args: object, **kwargs: object) -> None:
            del args, kwargs
            raise OSError("sentinel-private-path")

        with patch(
            "sciretriever.storage.files.reconciliation._quarantine_unlink",
            side_effect=fail_unlink,
        ):
            with self.assertRaises(ArtifactReconciliationError) as captured:
                self.reconciler.reconcile()

        self.assertEqual(str(captured.exception), "artifact store reconciliation failed")
        self.assertNotIn("sentinel", str(captured.exception))
        self.assertTrue(all(self._artifact_file(item).is_file() for item in ordered))
        with self.engine.read_snapshot() as connection:
            remaining = tuple(
                row[0]
                for row in connection.execute(
                    "SELECT relative_path FROM artifact_objects ORDER BY relative_path"
                ).fetchall()
            )
        self.assertEqual(remaining, (ordered[1].path.root,))

    def test_row_first_crash_leaves_retryable_filesystem_only_evidence(self) -> None:
        first = self._publish(b"first-row-backed")
        second = self._publish(b"second-row-backed")
        self._insert_artifact("first", first)
        self._insert_artifact("second", second)
        ordered = sorted((first, second), key=lambda item: item.path.root)
        raised = False

        def checkpoint(name: str) -> None:
            nonlocal raised
            if name == "after-catalog-delete" and not raised:
                raised = True
                raise _InjectedFailure("simulated crash boundary")

        with self.assertRaises(ArtifactReconciliationError):
            self.reconciler.reconcile(checkpoint=checkpoint)

        self.assertTrue(self._artifact_file(ordered[0]).is_file())
        self.assertTrue(self._artifact_file(ordered[1]).is_file())
        with self.engine.read_snapshot() as connection:
            remaining = tuple(
                row[0]
                for row in connection.execute(
                    "SELECT relative_path FROM artifact_objects ORDER BY relative_path"
                ).fetchall()
            )
        self.assertEqual(remaining, (ordered[1].path.root,))

        recovered = self.reconciler.reconcile()
        self.assertEqual(
            recovered.deleted,
            tuple(item.path for item in ordered),
        )
        self.assertEqual(self._artifact_rows(), ())
        self.assertTrue(all(not self._artifact_file(item).exists() for item in ordered))

    def test_publication_window_is_protected_by_the_same_catalog_lock(self) -> None:
        published = self._publish(b"published-before-reference")

        with CatalogWriteLock(self.catalog_path):
            with self.assertRaises(CatalogLockConflictError):
                self.reconciler.reconcile()

        self.assertTrue(self._artifact_file(published).is_file())
        self._insert_artifact("published-after-window", published)

    def test_delete_failure_stops_before_later_candidates(self) -> None:
        first = self._publish(b"delete-first")
        second = self._publish(b"delete-second")
        self._insert_artifact("delete-first", first)
        self._insert_artifact("delete-second", second)
        ordered = sorted((first, second), key=lambda item: item.path.root)
        raised = False

        def checkpoint(name: str) -> None:
            nonlocal raised
            if name == "before-unlink" and not raised:
                raised = True
                raise _InjectedFailure("delete failpoint")

        with self.assertRaises(ArtifactReconciliationError):
            self.reconciler.reconcile(checkpoint=checkpoint)

        self.assertTrue(all(self._artifact_file(item).is_file() for item in ordered))
        with self.engine.read_snapshot() as connection:
            remaining = tuple(
                row[0]
                for row in connection.execute(
                    "SELECT relative_path FROM artifact_objects ORDER BY relative_path"
                ).fetchall()
            )
        self.assertEqual(remaining, (ordered[1].path.root,))

    def test_unexpected_programming_errors_propagate_unchanged(self) -> None:
        assertion = AssertionError("assertion defect")
        with (
            patch.object(ArtifactStoreReconciler, "_reconcile", side_effect=assertion),
            self.assertRaises(AssertionError) as captured_assertion,
        ):
            self.reconciler.reconcile()
        self.assertIs(captured_assertion.exception, assertion)

        runtime = _InjectedFailure("runtime defect")
        with (
            patch(
                "sciretriever.storage.files.reconciliation._scan_formal_objects",
                side_effect=runtime,
            ),
            self.assertRaises(_InjectedFailure) as captured_runtime,
        ):
            self.reconciler.reconcile()
        self.assertIs(captured_runtime.exception, runtime)

        interrupt = KeyboardInterrupt("interrupt")
        with (
            patch.object(ArtifactStoreReconciler, "_reconcile", side_effect=interrupt),
            self.assertRaises(KeyboardInterrupt) as captured_interrupt,
        ):
            self.reconciler.reconcile()
        self.assertIs(captured_interrupt.exception, interrupt)


if __name__ == "__main__":
    unittest.main()
