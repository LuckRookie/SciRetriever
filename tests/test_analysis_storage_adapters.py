from __future__ import annotations

import os
import sqlite3
import unittest
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Generator
from unittest.mock import patch

import sciretriever.storage.analysis_artifacts as analysis_artifact_publication_module
import sciretriever.storage.sqlite.analysis_artifacts as analysis_artifact_reader_module
from sciretriever.analysis.ports import (
    AnalysisArtifactPublicationPort,
    AnalysisArtifactReadPort,
    AnalysisCurrentInputPort,
    ContentInputIdentity,
    StagedContentMarkdown,
)
from sciretriever.model.analysis import ArtifactRef
from sciretriever.model.parsing import ParserArtifactRef
from sciretriever.model.primitives import (
    AssetId,
    LiteratureId,
    Sha256,
    sha256_digest,
)
from sciretriever.storage.analysis_artifacts import (
    AnalysisArtifactPublicationError,
    AnalysisArtifactPublisher,
)
from sciretriever.storage.files.paths import StorageRoot, content_addressed_reference
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactReference, ArtifactStore
from sciretriever.storage.sqlite.analysis_artifacts import (
    AnalysisArtifactReader,
    AnalysisArtifactReadError,
)
from sciretriever.storage.sqlite.analysis_inputs import (
    AnalysisCurrentInputError,
    SqliteAnalysisCurrentInputs,
)
from sciretriever.storage.sqlite.artifacts import register_artifact
from sciretriever.storage.sqlite.engine import CatalogEngine

_PRIVATE_PATH = "/private/alice/analysis/final-content.md"
_PRIVATE_MARKDOWN = b"# Private analysis body\n\nDo not expose this text.\n"
_LITERATURE_ID = LiteratureId("20000001-e89b-42d3-a456-426614174000")
_PRIMARY_ASSET_ID = AssetId("20000002-e89b-42d3-a456-426614174000")
_METADATA_SHA256 = Sha256("a" * 64)
_PARSER_RESULT_SHA256 = Sha256("b" * 64)


def _uuid(number: int) -> str:
    return f"20000000-0000-4000-8000-{number:012x}"


def _staged(payload: bytes = _PRIVATE_MARKDOWN) -> StagedContentMarkdown:
    return StagedContentMarkdown(
        artifact=ArtifactRef(
            sha256=sha256_digest(payload),
            media_type="text/markdown",
            byte_size=len(payload),
        ),
        content=payload,
    )


class _Environment:
    def __init__(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-analysis-storage-")
        self.base = Path(self.temporary.name)
        os.chmod(self.base, 0o700)
        self.root = StorageRoot(self.base / "artifacts")
        self.store = ArtifactStore(self.root, max_artifact_bytes=1024 * 1024)
        self.verified_reader = VerifiedReader(self.root, max_artifact_bytes=1024 * 1024)
        self.engine = CatalogEngine(self.base / "catalog.sqlite")
        self.publisher = AnalysisArtifactPublisher(self.store)
        self.reader = AnalysisArtifactReader(self.engine, self.verified_reader)
        self.current_inputs = SqliteAnalysisCurrentInputs(self.engine)

    def cleanup(self) -> None:
        self.temporary.cleanup()

    def publish_registered(
        self,
        payload: bytes,
        media_type: str,
        artifact_id: str,
    ) -> ArtifactReference:
        reference = self.store.publish(
            payload,
            sha256=sha256_digest(payload),
            byte_size=len(payload),
            media_type=media_type,
        )
        with self.verified_reader.acquire(reference) as lease:
            register_artifact(self.engine, artifact_id, lease)
        return reference

    def seed_current_input(
        self,
        *,
        primary_media_type: str = "application/pdf",
    ) -> ContentInputIdentity:
        pdf_payload = b"%PDF-1.7\noffline analysis fixture\n"
        parser_payload = b"# Parser Markdown\n\nBounded fixture.\n"
        pdf = self.publish_registered(pdf_payload, primary_media_type, "analysis-primary-object")
        parser = self.publish_registered(
            parser_payload,
            "text/markdown",
            "analysis-parser-object",
        )
        asset_provenance_id = _uuid(10)
        parser_provenance_id = _uuid(11)
        meta_literature_id = _uuid(12)
        literature_asset_id = _uuid(13)
        with self.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO provenances(provenance_id,source_kind,source_name,source_record_id,"
                "observed_at,input_sha256,parameters_sha256) VALUES(?,?,?,?,?,?,?)",
                (
                    asset_provenance_id,
                    "asset-provider",
                    "offline-fixture",
                    None,
                    "2026-08-12T10:00:00Z",
                    None,
                    None,
                ),
            )
            connection.execute(
                "INSERT INTO provenances(provenance_id,source_kind,source_name,source_record_id,"
                "observed_at,input_sha256,parameters_sha256) VALUES(?,?,?,?,?,?,?)",
                (
                    parser_provenance_id,
                    "parser",
                    "offline-parser",
                    None,
                    "2026-08-12T10:01:00Z",
                    pdf.sha256.root,
                    "c" * 64,
                ),
            )
            connection.execute(
                "INSERT INTO literatures(literature_id,meta_literature_id,version_role) "
                "VALUES(?,?,?)",
                (_LITERATURE_ID.root, meta_literature_id, "other"),
            )
            connection.execute(
                "INSERT INTO meta_literatures(meta_literature_id,representative_literature_id) "
                "VALUES(?,?)",
                (meta_literature_id, _LITERATURE_ID.root),
            )
            connection.execute(
                "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256) "
                "VALUES(?,?,?)",
                (_LITERATURE_ID.root, 3, _METADATA_SHA256.root),
            )
            connection.execute(
                "INSERT INTO assets(asset_id,sha256,size_bytes,media_type,relative_path) "
                "VALUES(?,?,?,?,?)",
                (
                    _PRIMARY_ASSET_ID.root,
                    pdf.sha256.root,
                    pdf.byte_size,
                    pdf.media_type,
                    pdf.path.root,
                ),
            )
            connection.execute(
                "INSERT INTO literature_assets(literature_asset_id,literature_id,asset_id,role,"
                "provenance_id,source_url) VALUES(?,?,?,?,?,?)",
                (
                    literature_asset_id,
                    _LITERATURE_ID.root,
                    _PRIMARY_ASSET_ID.root,
                    "primary-pdf",
                    asset_provenance_id,
                    None,
                ),
            )
            connection.execute(
                "INSERT INTO parser_results(source_asset_id,source_sha256,result_sha256,"
                "page_count,markdown_artifact_path,markdown_sha256,markdown_byte_size,"
                "markdown_media_type,provenance_id,parser_version,mode,model_identity) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    _PRIMARY_ASSET_ID.root,
                    pdf.sha256.root,
                    _PARSER_RESULT_SHA256.root,
                    2,
                    parser.path.root,
                    parser.sha256.root,
                    parser.byte_size,
                    parser.media_type,
                    parser_provenance_id,
                    "fixture-1",
                    "offline",
                    None,
                ),
            )
        return ContentInputIdentity(
            literature_id=_LITERATURE_ID,
            primary_asset_id=_PRIMARY_ASSET_ID,
            primary_pdf_sha256=pdf.sha256,
            parser_result_sha256=_PARSER_RESULT_SHA256,
            input_metadata_revision=3,
            input_metadata_sha256=_METADATA_SHA256,
        )


class AnalysisArtifactModuleOwnershipTests(unittest.TestCase):
    def test_publication_and_sqlite_reader_have_single_module_owners(self) -> None:
        self.assertEqual(
            analysis_artifact_publication_module.__all__,
            ("AnalysisArtifactPublicationError", "AnalysisArtifactPublisher"),
        )
        self.assertEqual(
            analysis_artifact_reader_module.__all__,
            ("AnalysisArtifactReadError", "AnalysisArtifactReader"),
        )
        self.assertNotIn(
            "AnalysisArtifactReader",
            vars(analysis_artifact_publication_module),
        )
        self.assertNotIn(
            "AnalysisArtifactReadError",
            vars(analysis_artifact_publication_module),
        )
        self.assertNotIn(
            "AnalysisArtifactPublisher",
            vars(analysis_artifact_reader_module),
        )
        self.assertEqual(
            AnalysisArtifactPublisher.__module__,
            "sciretriever.storage.analysis_artifacts",
        )
        self.assertEqual(
            AnalysisArtifactReader.__module__,
            "sciretriever.storage.sqlite.analysis_artifacts",
        )


class AnalysisArtifactPublisherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = _Environment()
        self.addCleanup(self.environment.cleanup)

    def test_create_if_absent_replay_returns_neutral_ref_without_catalog_registration(self) -> None:
        staged = _staged()
        publisher = self.environment.publisher

        first = publisher.publish_markdown(staged)
        second = publisher.publish_markdown(staged)

        self.assertIsInstance(publisher, AnalysisArtifactPublicationPort)
        self.assertEqual(first, staged.artifact)
        self.assertEqual(second, staged.artifact)
        self.assertIsInstance(first, ArtifactRef)
        with self.environment.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM artifact_objects").fetchone(), (0,)
            )
        path = content_addressed_reference(first.sha256, first.byte_size)
        with self.environment.verified_reader.open(
            path,
            sha256=first.sha256,
            byte_size=first.byte_size,
            media_type=first.media_type,
        ) as stream:
            self.assertEqual(stream.read(), _PRIVATE_MARKDOWN)
        rendered = f"{publisher!r} {staged!r}"
        self.assertNotIn(str(self.environment.base), rendered)
        self.assertNotIn(_PRIVATE_MARKDOWN.decode(), rendered)

    def test_staged_bytes_and_store_descriptor_mismatches_fail_closed(self) -> None:
        staged = _staged()
        object.__setattr__(staged, "content", b"different private bytes")
        with self.assertRaises(AnalysisArtifactPublicationError) as caught:
            self.environment.publisher.publish_markdown(staged)
        self.assertNotIn("different private bytes", f"{caught.exception!s} {caught.exception!r}")

        valid = _staged()
        other_payload = b"# Different descriptor\n"
        other_hash = sha256_digest(other_payload)
        wrong_reference = ArtifactReference(
            path=content_addressed_reference(other_hash, len(other_payload)),
            sha256=other_hash,
            byte_size=len(other_payload),
            media_type="text/markdown",
        )
        with patch.object(ArtifactStore, "publish", return_value=wrong_reference):
            with self.assertRaises(AnalysisArtifactPublicationError) as caught:
                self.environment.publisher.publish_markdown(valid)
        self.assertNotIn(
            other_payload.decode().strip(), f"{caught.exception!s} {caught.exception!r}"
        )

    def test_store_failure_is_stable_path_free_and_does_not_register_catalog(self) -> None:
        with patch.object(
            ArtifactStore,
            "publish",
            side_effect=RuntimeError(f"failed at {_PRIVATE_PATH}: {_PRIVATE_MARKDOWN!r}"),
        ):
            with self.assertRaises(AnalysisArtifactPublicationError) as caught:
                self.environment.publisher.publish_markdown(_staged())

        rendered = f"{caught.exception!s} {caught.exception!r}"
        self.assertNotIn(_PRIVATE_PATH, rendered)
        self.assertNotIn("Private analysis body", rendered)
        with self.environment.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM artifact_objects").fetchone(), (0,)
            )


class AnalysisArtifactReaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = _Environment()
        self.addCleanup(self.environment.cleanup)

    def _registered_parser_artifact(
        self,
        payload: bytes = b"# Registered parser artifact\n",
    ) -> tuple[ArtifactReference, ParserArtifactRef]:
        artifact_id = f"analysis-reader-{sha256_digest(payload).root}"
        stored = self.environment.publish_registered(payload, "text/markdown", artifact_id)
        return (
            stored,
            ParserArtifactRef(
                sha256=stored.sha256,
                media_type=stored.media_type,
                byte_size=stored.byte_size,
            ),
        )

    def test_registered_parser_artifact_opens_verified_context_managed_bytes(self) -> None:
        payload = b"# Registered parser artifact\n"
        _stored, reference = self._registered_parser_artifact(payload)

        with self.environment.reader.open_artifact(reference) as stream:
            self.assertEqual(stream.read(), payload)
            self.assertFalse(stream.closed)

        self.assertTrue(stream.closed)
        self.assertIsInstance(self.environment.reader, AnalysisArtifactReadPort)
        rendered = repr(self.environment.reader)
        self.assertNotIn(str(self.environment.base), rendered)

    def test_missing_catalog_missing_file_tamper_and_descriptor_mismatch_are_rejected(self) -> None:
        missing_payload = b"published without a Catalog row"
        missing = self.environment.store.publish(
            missing_payload,
            sha256=sha256_digest(missing_payload),
            byte_size=len(missing_payload),
            media_type="text/markdown",
        )
        missing_ref = ParserArtifactRef(
            sha256=missing.sha256,
            media_type=missing.media_type,
            byte_size=missing.byte_size,
        )
        with self.assertRaises(AnalysisArtifactReadError):
            with self.environment.reader.open_artifact(missing_ref):
                self.fail("missing Catalog object must not open")

        stored_file, file_ref = self._registered_parser_artifact(b"# Missing file\n")
        exact_file = self.environment.base / "artifacts" / stored_file.path.root
        exact_file.unlink()
        with self.assertRaises(AnalysisArtifactReadError):
            with self.environment.reader.open_artifact(file_ref):
                self.fail("missing artifact file must not open")

        stored_tampered, tampered_ref = self._registered_parser_artifact(b"# Original bytes\n")
        exact_tampered = self.environment.base / "artifacts" / stored_tampered.path.root
        exact_tampered.write_bytes(b"# Tampered bytes\n")
        os.chmod(exact_tampered, 0o600)
        with self.assertRaises(AnalysisArtifactReadError):
            with self.environment.reader.open_artifact(tampered_ref):
                self.fail("tampered artifact file must not open")

        _stored, registered = self._registered_parser_artifact(b"# Media descriptor\n")
        mismatched = ParserArtifactRef(
            sha256=registered.sha256,
            media_type="text/plain",
            byte_size=registered.byte_size,
        )
        with self.assertRaises(AnalysisArtifactReadError):
            with self.environment.reader.open_artifact(mismatched):
                self.fail("mismatched Catalog descriptor must not open")

    def test_catalog_snapshot_is_closed_before_stream_is_returned_to_caller(self) -> None:
        payload = b"# Short snapshot\n"
        _stored, reference = self._registered_parser_artifact(payload)
        original = CatalogEngine.read_snapshot
        active_snapshots = 0
        snapshot_calls = 0

        @contextmanager
        def tracked(engine: CatalogEngine) -> Generator[sqlite3.Connection, None, None]:
            nonlocal active_snapshots, snapshot_calls
            with original(engine) as connection:
                active_snapshots += 1
                snapshot_calls += 1
                try:
                    yield connection
                finally:
                    active_snapshots -= 1

        with patch.object(CatalogEngine, "read_snapshot", tracked):
            context = self.environment.reader.open_artifact(reference)
            self.assertEqual(active_snapshots, 0)
            with context as stream:
                self.assertEqual(active_snapshots, 0)
                self.assertEqual(stream.read(), payload)
            self.assertEqual(active_snapshots, 0)
        self.assertEqual(snapshot_calls, 1)

    def test_read_failures_do_not_expose_catalog_root_or_reference(self) -> None:
        payload = b"private missing parser bytes"
        reference = ParserArtifactRef(
            sha256=sha256_digest(payload),
            media_type="text/markdown",
            byte_size=len(payload),
        )
        with self.assertRaises(AnalysisArtifactReadError) as caught:
            with self.environment.reader.open_artifact(reference):
                self.fail("missing private parser bytes must not open")
        rendered = f"{caught.exception!s} {caught.exception!r}"
        self.assertNotIn(str(self.environment.base), rendered)
        self.assertNotIn(reference.sha256.root, rendered)
        self.assertNotIn(payload.decode(), rendered)


def _malformed_connection(
    identity: ContentInputIdentity,
    case: str,
) -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.execute("CREATE TABLE literatures(literature_id TEXT)")
    connection.execute(
        "CREATE TABLE literature_metadata("
        "literature_id TEXT,metadata_revision,metadata_sha256 TEXT)"
    )
    connection.execute("CREATE TABLE literature_assets(literature_id TEXT,asset_id TEXT,role TEXT)")
    connection.execute("CREATE TABLE assets(asset_id TEXT,sha256 TEXT,size_bytes,media_type TEXT)")
    connection.execute(
        "CREATE TABLE parser_results(source_asset_id TEXT,source_sha256 TEXT,result_sha256 TEXT,"
        "page_count,markdown_artifact_path TEXT,markdown_sha256 TEXT,markdown_byte_size,"
        "markdown_media_type TEXT)"
    )
    connection.execute("INSERT INTO literatures VALUES(?)", (identity.literature_id.root,))
    if case != "missing-metadata":
        connection.execute(
            "INSERT INTO literature_metadata VALUES(?,?,?)",
            (
                identity.literature_id.root,
                identity.input_metadata_revision,
                identity.input_metadata_sha256.root,
            ),
        )
    media_type = "text/html" if case == "bad-primary-media" else "application/pdf"
    connection.execute(
        "INSERT INTO assets VALUES(?,?,?,?)",
        (identity.primary_asset_id.root, identity.primary_pdf_sha256.root, 123, media_type),
    )
    connection.execute(
        "INSERT INTO literature_assets VALUES(?,?,?)",
        (identity.literature_id.root, identity.primary_asset_id.root, "primary-pdf"),
    )
    if case == "duplicate-primary":
        second_asset_id = AssetId(_uuid(901))
        connection.execute(
            "INSERT INTO assets VALUES(?,?,?,?)",
            (second_asset_id.root, "d" * 64, 456, "application/pdf"),
        )
        connection.execute(
            "INSERT INTO literature_assets VALUES(?,?,?)",
            (identity.literature_id.root, second_asset_id.root, "primary-pdf"),
        )
    parser_source_hash = (
        "e" * 64 if case == "parser-source-mismatch" else identity.primary_pdf_sha256.root
    )
    markdown_sha256 = Sha256("f" * 64)
    markdown_byte_size = 50
    parser_row = (
        identity.primary_asset_id.root,
        parser_source_hash,
        identity.parser_result_sha256.root,
        2,
        content_addressed_reference(markdown_sha256, markdown_byte_size).root,
        markdown_sha256.root,
        markdown_byte_size,
        "text/markdown",
    )
    connection.execute("INSERT INTO parser_results VALUES(?,?,?,?,?,?,?,?)", parser_row)
    if case == "duplicate-parser":
        connection.execute("INSERT INTO parser_results VALUES(?,?,?,?,?,?,?,?)", parser_row)
    if case == "invalid-parser-row":
        connection.execute("UPDATE parser_results SET page_count=0")
    connection.commit()
    return connection


class AnalysisCurrentInputTests(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = _Environment()
        self.addCleanup(self.environment.cleanup)

    def test_exact_current_input_matches_and_each_stale_identity_returns_false(self) -> None:
        identity = self.environment.seed_current_input()
        adapter = self.environment.current_inputs

        self.assertTrue(adapter.current_input_matches(identity))
        self.assertIsInstance(adapter, AnalysisCurrentInputPort)
        stale_identities = (
            replace(identity, literature_id=LiteratureId(_uuid(700))),
            replace(identity, primary_asset_id=AssetId(_uuid(701))),
            replace(identity, primary_pdf_sha256=Sha256("1" * 64)),
            replace(identity, parser_result_sha256=Sha256("2" * 64)),
            replace(identity, input_metadata_revision=identity.input_metadata_revision + 1),
            replace(identity, input_metadata_sha256=Sha256("3" * 64)),
        )
        for stale in stale_identities:
            with self.subTest(field_difference=stale):
                self.assertFalse(adapter.current_input_matches(stale))

    def test_missing_current_primary_or_parser_is_normal_stale(self) -> None:
        identity = self.environment.seed_current_input()
        with self.environment.engine.write_transaction() as connection:
            connection.execute(
                "DELETE FROM parser_results WHERE source_asset_id=?",
                (identity.primary_asset_id.root,),
            )
        self.assertFalse(self.environment.current_inputs.current_input_matches(identity))

        with self.environment.engine.write_transaction() as connection:
            connection.execute(
                "DELETE FROM literature_assets WHERE literature_id=? AND role='primary-pdf'",
                (identity.literature_id.root,),
            )
        self.assertFalse(self.environment.current_inputs.current_input_matches(identity))

    def test_duplicate_conflicting_and_illegal_catalog_shapes_are_adapter_errors(self) -> None:
        identity = self.environment.seed_current_input()
        for case in (
            "missing-metadata",
            "duplicate-primary",
            "duplicate-parser",
            "bad-primary-media",
            "parser-source-mismatch",
            "invalid-parser-row",
        ):
            with self.subTest(case=case):
                malformed = _malformed_connection(identity, case)

                @contextmanager
                def malformed_snapshot(
                    _engine: CatalogEngine,
                ) -> Generator[sqlite3.Connection, None, None]:
                    yield malformed

                try:
                    with patch.object(CatalogEngine, "read_snapshot", malformed_snapshot):
                        with self.assertRaises(AnalysisCurrentInputError) as caught:
                            self.environment.current_inputs.current_input_matches(identity)
                finally:
                    malformed.close()
                rendered = f"{caught.exception!s} {caught.exception!r}"
                self.assertNotIn(case, rendered)
                self.assertNotIn(str(self.environment.base), rendered)

    def test_primary_role_with_non_pdf_asset_is_corruption_not_stale(self) -> None:
        identity = self.environment.seed_current_input(primary_media_type="text/plain")
        with self.assertRaises(AnalysisCurrentInputError):
            self.environment.current_inputs.current_input_matches(identity)

    def test_one_read_snapshot_is_closed_before_boolean_return(self) -> None:
        identity = self.environment.seed_current_input()
        original = CatalogEngine.read_snapshot
        active_snapshots = 0
        snapshot_calls = 0

        @contextmanager
        def tracked(engine: CatalogEngine) -> Generator[sqlite3.Connection, None, None]:
            nonlocal active_snapshots, snapshot_calls
            with original(engine) as connection:
                active_snapshots += 1
                snapshot_calls += 1
                try:
                    yield connection
                finally:
                    active_snapshots -= 1

        with patch.object(CatalogEngine, "read_snapshot", tracked):
            result = self.environment.current_inputs.current_input_matches(identity)
            self.assertEqual(active_snapshots, 0)

        self.assertTrue(result)
        self.assertEqual(snapshot_calls, 1)
        self.assertNotIn(str(self.environment.base), repr(self.environment.current_inputs))

    def test_catalog_failure_is_stable_and_path_free(self) -> None:
        identity = self.environment.seed_current_input()

        @contextmanager
        def failing_snapshot(
            _engine: CatalogEngine,
        ) -> Generator[sqlite3.Connection, None, None]:
            raise RuntimeError(f"failed reading {_PRIVATE_PATH}")
            yield sqlite3.connect(":memory:")  # pragma: no cover

        with patch.object(CatalogEngine, "read_snapshot", failing_snapshot):
            with self.assertRaises(AnalysisCurrentInputError) as caught:
                self.environment.current_inputs.current_input_matches(identity)
        rendered = f"{caught.exception!s} {caught.exception!r}"
        self.assertNotIn(_PRIVATE_PATH, rendered)
        self.assertNotIn(str(self.environment.base), rendered)


if __name__ == "__main__":
    unittest.main()
