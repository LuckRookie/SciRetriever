from __future__ import annotations

import io
import os
import unittest
from collections.abc import Callable, Generator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

from sciretriever.analysis.markdown import render_canonical_markdown
from sciretriever.literature.content import (
    ContentAcceptanceReplacement,
    canonical_literature_content_json,
    literature_content_artifact,
    metadata_sha256,
)
from sciretriever.literature.ports import (
    ContentPublicationCommand,
    IdentityObservationPublicationCommand,
    LiteratureIdentityToken,
)
from sciretriever.literature.state import CurrentLiteratureFacts
from sciretriever.model.acquisition import Asset, AssetRole, LiteratureAsset
from sciretriever.model.analysis import (
    ArtifactRef,
    LiteratureContent,
    LiteratureSection,
    LiteratureSectionRole,
    analysis_input_sha256,
    content_sha256,
)
from sciretriever.model.literature import (
    Identifier,
    Literature,
    LiteratureStatus,
    MetaLiterature,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.parsing import (
    ParserArtifactRef,
    ParserProvenance,
    ParserResource,
    ParserResult,
    parser_result_sha256,
)
from sciretriever.model.primitives import (
    AssetId,
    LiteratureAssetId,
    LiteratureId,
    MetaLiteratureId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.parsing.ports import (
    ParserResultPublicationCommand,
    StagedParserArtifact,
    StagedParserResource,
)
from sciretriever.parsing.publication import ParserResultPublisher
from sciretriever.storage.files.paths import StorageRoot, content_addressed_reference
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactReference, ArtifactStore
from sciretriever.storage.sqlite.artifacts import register_artifact
from sciretriever.storage.sqlite.content_publication import SqliteContentPublication
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.literature_reader import LiteratureReader
from sciretriever.storage.sqlite.literature_writer import LiteratureWriter
from sciretriever.storage.sqlite.parsing_publication import (
    PARSER_RESULT_PUBLICATION_FAILPOINTS,
    ParserResultPublicationConflictError,
    ParserResultPublicationError,
    ParserResultPublicationIntegrityError,
    SqliteParserResultPublication,
)

_TIMESTAMP = UtcTimestamp("2026-08-12T08:00:00Z")


def _uuid(number: int) -> str:
    return f"00000000-0000-4000-8000-{number:012x}"


def _metadata(number: int) -> LiteratureMetadata:
    return LiteratureMetadata(
        title=f"Atomic parser publication {number}",
        abstract="An offline parser-publication fixture.",
        publication_year=2026,
        identifiers=(Identifier(namespace="doi", value=f"10.1000/parser-{number}"),),
        keywords=("atomic", "parsing"),
    )


def _literature(number: int) -> Literature:
    return Literature(
        literature_id=LiteratureId(_uuid(1000 + number)),
        meta_literature_id=MetaLiteratureId(_uuid(2000 + number)),
        version_role=VersionRole.OTHER,
        metadata=_metadata(number),
        status=LiteratureStatus.UNREVIEWED,
    )


class _BytesContent:
    __slots__ = ("_payload", "open_count")

    def __init__(self, payload: bytes) -> None:
        self._payload = payload
        self.open_count = 0

    @contextmanager
    def open(self) -> Generator[io.BytesIO, None, None]:
        self.open_count += 1
        stream = io.BytesIO(self._payload)
        try:
            yield stream
        finally:
            stream.close()

    def __repr__(self) -> str:
        return "<_BytesContent>"


class _FailingContent:
    @contextmanager
    def open(self) -> Generator[io.BytesIO, None, None]:
        raise OSError("private staged failure")
        yield io.BytesIO()  # pragma: no cover


def _staged(payload: bytes, media_type: str) -> StagedParserArtifact:
    return StagedParserArtifact(
        artifact=ParserArtifactRef(
            sha256=sha256_digest(payload),
            media_type=media_type,
            byte_size=len(payload),
        ),
        content=_BytesContent(payload),
    )


def _command(
    asset_id: AssetId,
    source_sha256: Sha256,
    *,
    number: int,
    markdown_payload: bytes | None = None,
    resources: tuple[tuple[str, bytes, str], ...] = (),
    parser_version: str | None = None,
    mode: str | None = "offline",
    model_identity: str | None = None,
) -> ParserResultPublicationCommand:
    markdown_bytes = markdown_payload
    if markdown_bytes is None:
        lines = [f"# Parser result {number}"]
        lines.extend(
            f"![resource-{index}]({reference})"
            for index, (reference, _payload, _media_type) in enumerate(resources)
        )
        markdown_bytes = ("\n\n".join(lines) + "\n").encode()
    markdown = _staged(markdown_bytes, "text/markdown")
    staged_resources = tuple(
        sorted(
            (
                StagedParserResource(
                    reference=reference,
                    artifact=_staged(payload, media_type),
                )
                for reference, payload, media_type in resources
            ),
            key=lambda item: item.reference,
        )
    )
    parser_resources = tuple(
        ParserResource(
            reference=resource.reference,
            artifact=resource.artifact.artifact,
        )
        for resource in staged_resources
    )
    provenance = ParserProvenance(
        provenance=Provenance(
            provenance_id=ProvenanceId(_uuid(3000 + number)),
            source_kind=SourceKind.PARSER,
            source_name="fixture-parser",
            source_record_id=None,
            observed_at=_TIMESTAMP,
            input_sha256=source_sha256,
            parameters_sha256=sha256_digest(f"parameters-{number}".encode()),
        ),
        parser_version=f"1.{number}" if parser_version is None else parser_version,
        mode=mode,
        model_identity=model_identity,
    )
    result = ParserResult(
        source_asset_id=asset_id,
        source_sha256=source_sha256,
        page_count=number,
        markdown=markdown.artifact,
        resources=parser_resources,
        result_sha256=parser_result_sha256(
            source_asset_id=asset_id,
            source_sha256=source_sha256,
            page_count=number,
            markdown=markdown.artifact,
            resources=parser_resources,
            provenance=provenance,
        ),
        provenance=provenance,
    )
    return ParserResultPublicationCommand(
        result=result,
        markdown=markdown,
        resources=staged_resources,
    )


def _replay_with_new_attempt(
    command: ParserResultPublicationCommand,
    *,
    number: int,
) -> ParserResultPublicationCommand:
    current = command.result
    parser_provenance = current.provenance
    shared = parser_provenance.provenance
    replay_provenance = ParserProvenance(
        provenance=Provenance(
            provenance_id=ProvenanceId(_uuid(900000 + number)),
            source_kind=shared.source_kind,
            source_name=shared.source_name,
            source_record_id=shared.source_record_id,
            observed_at=UtcTimestamp("2026-08-12T09:00:00Z"),
            input_sha256=shared.input_sha256,
            parameters_sha256=shared.parameters_sha256,
        ),
        parser_version=parser_provenance.parser_version,
        mode=parser_provenance.mode,
        model_identity=parser_provenance.model_identity,
    )
    replay_result = ParserResult(
        source_asset_id=current.source_asset_id,
        source_sha256=current.source_sha256,
        page_count=current.page_count,
        markdown=current.markdown,
        resources=current.resources,
        result_sha256=current.result_sha256,
        provenance=replay_provenance,
    )
    return ParserResultPublicationCommand(
        result=replay_result,
        markdown=command.markdown,
        resources=command.resources,
    )


def _fail_at(expected: str) -> Callable[[str], None]:
    def checkpoint(name: str) -> None:
        if name == expected:
            raise RuntimeError("injected parser publication failure")

    return checkpoint


class _Environment:
    def __init__(self, number: int = 1) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-p3-")
        self.base = Path(self.temporary.name)
        self.artifact_directory = self.base / "artifacts"
        self.root = StorageRoot(self.artifact_directory)
        self.engine = CatalogEngine(self.base / "catalog.sqlite")
        self.store = ArtifactStore(self.root)
        self.verified_reader = VerifiedReader(self.root)
        self.writer = LiteratureWriter(self.engine)
        self.reader = LiteratureReader(self.engine, self.verified_reader)
        self.content_publication = SqliteContentPublication(
            self.engine,
            self.store,
            self.verified_reader,
        )
        self.literature, self.asset = self.add_primary(number)

    def cleanup(self) -> None:
        self.temporary.cleanup()

    def adapter(
        self,
        *,
        failpoint: Callable[[str], None] | None = None,
    ) -> SqliteParserResultPublication:
        return SqliteParserResultPublication(
            self.engine,
            self.store,
            self.verified_reader,
            failpoint=failpoint,
        )

    def _publish_literature(self, literature: Literature) -> None:
        self.writer.publish_identity_and_observation(
            IdentityObservationPublicationCommand(
                literatures=(literature,),
                meta_literatures=(
                    MetaLiterature(
                        meta_literature_id=literature.meta_literature_id,
                        representative_literature_id=literature.literature_id,
                    ),
                ),
                observations=(),
                facts=(
                    CurrentLiteratureFacts(
                        literature=literature,
                        metadata_revision=1,
                        metadata_sha256=metadata_sha256(literature.metadata),
                    ),
                ),
                expected_tokens=(),
                expected_meta_tokens=(),
            )
        )

    def publish_bytes(
        self,
        payload: bytes,
        media_type: str,
        artifact_id: str,
        *,
        register: bool = True,
    ) -> ArtifactReference:
        reference = self.store.publish(
            payload,
            sha256=sha256_digest(payload),
            byte_size=len(payload),
            media_type=media_type,
        )
        if register:
            with self.verified_reader.acquire(reference) as lease:
                register_artifact(self.engine, artifact_id, lease)
        return reference

    def add_primary(self, number: int) -> tuple[Literature, Asset]:
        literature = _literature(number)
        self._publish_literature(literature)
        pdf_bytes = f"%PDF-1.7\noffline-{number}\n".encode()
        published = self.publish_bytes(
            pdf_bytes,
            "application/pdf",
            f"primary-pdf-{number}",
        )
        asset = Asset(
            asset_id=AssetId(_uuid(4000 + number)),
            sha256=published.sha256,
            size_bytes=published.byte_size,
            media_type=published.media_type,
            path=published.path,
        )
        self.writer.publish_asset(asset)
        self.writer.publish_literature_asset(
            LiteratureAsset(
                literature_asset_id=LiteratureAssetId(_uuid(5000 + number)),
                literature_id=literature.literature_id,
                asset_id=asset.asset_id,
                role=AssetRole.PRIMARY_PDF,
                provenance=Provenance(
                    provenance_id=ProvenanceId(_uuid(6000 + number)),
                    source_kind=SourceKind.ASSET_PROVIDER,
                    source_name="fixture-assets",
                    source_record_id=f"asset-{number}",
                    observed_at=_TIMESTAMP,
                    input_sha256=asset.sha256,
                    parameters_sha256=None,
                ),
            )
        )
        return literature, asset

    @staticmethod
    def _sections(number: int) -> tuple[LiteratureSection, ...]:
        return tuple(
            LiteratureSection(
                role=role,
                markdown=f"Accepted body {number} for {role.value}.",
            )
            for role in (
                LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
                LiteratureSectionRole.METHODS,
                LiteratureSectionRole.DATA,
                LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
            )
        )

    def content_markdown(self, literature: Literature, *, number: int) -> bytes:
        return render_canonical_markdown(
            metadata=literature.metadata,
            sections=self._sections(number),
            references=("A retained reference.",),
        )

    def publish_content(
        self,
        literature: Literature,
        asset: Asset,
        parser_result: ParserResult,
        *,
        number: int,
        markdown_bytes: bytes | None = None,
    ) -> LiteratureContent:
        sections = self._sections(number)
        references = ("A retained reference.",)
        digest = metadata_sha256(literature.metadata)
        actual_markdown = markdown_bytes or self.content_markdown(literature, number=number)
        markdown_reference = self.store.publish(
            actual_markdown,
            sha256=sha256_digest(actual_markdown),
            byte_size=len(actual_markdown),
            media_type="text/markdown",
        )
        content = LiteratureContent(
            literature_content_sha256=content_sha256(
                metadata_sha256=digest,
                sections=sections,
                references=references,
            ),
            metadata_revision=1,
            metadata_sha256=digest,
            sections=sections,
            references=references,
            markdown=ArtifactRef(
                sha256=markdown_reference.sha256,
                byte_size=markdown_reference.byte_size,
                media_type=markdown_reference.media_type,
            ),
            provenance=Provenance(
                provenance_id=ProvenanceId(_uuid(7000 + number)),
                source_kind=SourceKind.ANALYSIS,
                source_name="fixture-analysis/model",
                source_record_id=None,
                observed_at=_TIMESTAMP,
                input_sha256=analysis_input_sha256(
                    asset.sha256,
                    parser_result.result_sha256,
                    digest,
                ),
                parameters_sha256=sha256_digest(f"analysis-{number}".encode()),
            ),
        )
        encoded = canonical_literature_content_json(content)
        self.content_publication.publish_content(
            ContentPublicationCommand(
                expected_token=LiteratureIdentityToken(
                    literature_id=literature.literature_id,
                    meta_literature_id=literature.meta_literature_id,
                    metadata_revision=1,
                    metadata_sha256=digest,
                ),
                expected_primary_asset_id=asset.asset_id,
                expected_primary_pdf_sha256=asset.sha256,
                expected_parser_result_sha256=parser_result.result_sha256,
                replacement=ContentAcceptanceReplacement(
                    literature_id=literature.literature_id,
                    metadata=literature.metadata,
                    metadata_revision=1,
                    metadata_sha256=digest,
                    content=content,
                ),
                structured_artifact=literature_content_artifact(content),
                structured_content=_BytesContent(encoded),
            )
        )
        return content

    def snapshot(self) -> tuple[object, ...]:
        with self.engine.read_snapshot() as connection:
            return (
                tuple(connection.execute("SELECT * FROM parser_results ORDER BY source_asset_id")),
                tuple(
                    connection.execute(
                        "SELECT * FROM parser_result_resources ORDER BY source_asset_id,ordinal"
                    )
                ),
                tuple(
                    connection.execute("SELECT * FROM literature_contents ORDER BY literature_id")
                ),
                tuple(connection.execute("SELECT * FROM artifact_objects ORDER BY artifact_id")),
                tuple(connection.execute("SELECT * FROM provenances ORDER BY provenance_id")),
            )


class ParserResultPublicationTests(unittest.TestCase):
    def _environment(self, number: int = 1) -> _Environment:
        environment = _Environment(number)
        self.addCleanup(environment.cleanup)
        return environment

    @staticmethod
    def _old_command(environment: _Environment) -> ParserResultPublicationCommand:
        return _command(
            environment.asset.asset_id,
            environment.asset.sha256,
            number=1,
            resources=(("images/old.png", b"\x89PNG\r\n\x1a\nold", "image/png"),),
        )

    @staticmethod
    def _new_command(environment: _Environment) -> ParserResultPublicationCommand:
        return _command(
            environment.asset.asset_id,
            environment.asset.sha256,
            number=2,
            resources=(
                ("images/new-a.png", b"\x89PNG\r\n\x1a\nnew-a", "image/png"),
                ("images/new-b.png", b"\x89PNG\r\n\x1a\nnew-b", "image/png"),
            ),
        )

    def test_create_if_absent_replay_is_idempotent_and_has_one_current_row(self) -> None:
        environment = self._environment()
        command = self._old_command(environment)
        adapter = environment.adapter()

        first = ParserResultPublisher(adapter).publish(command)
        before = environment.snapshot()
        object_path = environment.artifact_directory / command.markdown.artifact.sha256.root
        actual_path = (
            environment.artifact_directory
            / content_addressed_reference(
                command.markdown.artifact.sha256,
                command.markdown.artifact.byte_size,
            ).root
        )
        first_inode = os.stat(actual_path, follow_symlinks=False).st_ino
        second = adapter.publish_current(command)

        self.assertEqual(first, command.result)
        self.assertEqual(second, command.result)
        self.assertEqual(environment.snapshot(), before)
        self.assertEqual(os.stat(actual_path, follow_symlinks=False).st_ino, first_inode)
        self.assertFalse(object_path.exists())
        with environment.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM parser_results").fetchone(),
                (1,),
            )

    def test_legal_parser_identities_round_trip_through_the_catalog_unchanged(self) -> None:
        environment = self._environment(3)
        command = _command(
            environment.asset.asset_id,
            environment.asset.sha256,
            number=3,
            parser_version="3.4.4",
            mode="vlm-engine",
            model_identity="organization/model@revision",
        )
        adapter = environment.adapter()

        published = adapter.publish_current(command)
        current = adapter.read_current(environment.asset.asset_id)

        self.assertEqual(published, command.result)
        self.assertEqual(current, command.result)
        self.assertEqual(current.provenance.parser_version, "3.4.4")
        self.assertEqual(current.provenance.mode, "vlm-engine")
        self.assertEqual(current.provenance.model_identity, "organization/model@revision")
        with environment.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT parser_version,mode,model_identity FROM parser_results "
                    "WHERE source_asset_id=?",
                    (environment.asset.asset_id.root,),
                ).fetchone(),
                ("3.4.4", "vlm-engine", "organization/model@revision"),
            )

    def test_same_manifest_new_attempt_returns_existing_current_without_catalog_history(
        self,
    ) -> None:
        environment = self._environment(10)
        command = self._old_command(environment)
        replay = _replay_with_new_attempt(command, number=10)
        adapter = environment.adapter()
        adapter.publish_current(command)
        before = environment.snapshot()

        published = ParserResultPublisher(adapter).publish(replay)

        self.assertEqual(replay.result.result_sha256, command.result.result_sha256)
        self.assertNotEqual(replay.result.provenance, command.result.provenance)
        self.assertEqual(published, command.result)
        self.assertNotEqual(published, replay.result)
        self.assertEqual(adapter.read_current(environment.asset.asset_id), command.result)
        self.assertEqual(environment.snapshot(), before)
        with environment.engine.read_snapshot() as connection:
            self.assertIsNone(
                connection.execute(
                    "SELECT 1 FROM provenances WHERE provenance_id=?",
                    (replay.result.provenance.provenance.provenance_id.root,),
                ).fetchone()
            )

    def test_same_hash_does_not_mask_noncanonical_current_fields_or_resources(self) -> None:
        for offset, corruption in enumerate(("page-count", "resource-reference"), start=11):
            with self.subTest(corruption=corruption):
                environment = self._environment(offset)
                command = _command(
                    environment.asset.asset_id,
                    environment.asset.sha256,
                    number=offset,
                    resources=(("files/current.txt", b"current resource", "text/plain"),),
                )
                replay = _replay_with_new_attempt(command, number=offset)
                environment.adapter().publish_current(command)
                with environment.engine.write_transaction() as connection:
                    if corruption == "page-count":
                        connection.execute(
                            "UPDATE parser_results SET page_count=page_count+1 "
                            "WHERE source_asset_id=?",
                            (environment.asset.asset_id.root,),
                        )
                    else:
                        connection.execute(
                            "UPDATE parser_result_resources SET reference='files/changed.txt' "
                            "WHERE source_asset_id=?",
                            (environment.asset.asset_id.root,),
                        )
                before = environment.snapshot()

                with self.assertRaises(ParserResultPublicationIntegrityError):
                    ParserResultPublisher(environment.adapter()).publish(replay)

                self.assertEqual(environment.snapshot(), before)
                with environment.engine.read_snapshot() as connection:
                    self.assertIsNone(
                        connection.execute(
                            "SELECT 1 FROM provenances WHERE provenance_id=?",
                            (replay.result.provenance.provenance.provenance_id.root,),
                        ).fetchone()
                    )

    def test_different_result_atomically_replaces_resources_and_retires_catalog_history(
        self,
    ) -> None:
        environment = self._environment()
        adapter = environment.adapter()
        old = self._old_command(environment)
        new = self._new_command(environment)
        adapter.publish_current(old)
        old_paths = {
            content_addressed_reference(old.result.markdown.sha256, old.result.markdown.byte_size),
            *(
                content_addressed_reference(
                    resource.artifact.sha256,
                    resource.artifact.byte_size,
                )
                for resource in old.result.resources
            ),
        }

        published = adapter.publish_current(new)

        self.assertEqual(published, new.result)
        self.assertEqual(adapter.read_current(environment.asset.asset_id), new.result)
        with environment.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT source_asset_id,result_sha256 FROM parser_results"
                ).fetchall(),
                [(environment.asset.asset_id.root, new.result.result_sha256.root)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT ordinal,reference FROM parser_result_resources ORDER BY ordinal"
                ).fetchall(),
                [(0, "images/new-a.png"), (1, "images/new-b.png")],
            )
            for path in old_paths:
                self.assertIsNone(
                    connection.execute(
                        "SELECT 1 FROM artifact_objects WHERE relative_path=?",
                        (path.root,),
                    ).fetchone()
                )
            self.assertIsNone(
                connection.execute(
                    "SELECT 1 FROM provenances WHERE provenance_id=?",
                    (old.result.provenance.provenance.provenance_id.root,),
                ).fetchone()
            )
        for path in old_paths:
            self.assertTrue((environment.artifact_directory / path.root).is_file())

    def test_stale_primary_id_or_hash_and_storage_failure_leave_no_partial_new_facts(
        self,
    ) -> None:
        def stale_asset_id(environment: _Environment) -> ParserResultPublicationCommand:
            return _command(
                AssetId(_uuid(999001)),
                environment.asset.sha256,
                number=11,
            )

        def stale_asset_hash(environment: _Environment) -> ParserResultPublicationCommand:
            return _command(
                environment.asset.asset_id,
                Sha256("0" * 64),
                number=12,
            )

        for label, command_factory in (
            ("asset-id", stale_asset_id),
            ("asset-hash", stale_asset_hash),
        ):
            with self.subTest(stale=label):
                environment = self._environment(20 if label == "asset-id" else 21)
                before = environment.snapshot()
                with self.assertRaises(ParserResultPublicationConflictError):
                    environment.adapter().publish_current(command_factory(environment))
                self.assertEqual(environment.snapshot(), before)

        environment = self._environment(22)
        old = _command(environment.asset.asset_id, environment.asset.sha256, number=22)
        environment.adapter().publish_current(old)
        before = environment.snapshot()
        valid = _command(
            environment.asset.asset_id,
            environment.asset.sha256,
            number=23,
            resources=(("files/fail.txt", b"new resource", "text/plain"),),
        )
        failing_resource = StagedParserResource(
            reference=valid.resources[0].reference,
            artifact=StagedParserArtifact(
                artifact=valid.resources[0].artifact.artifact,
                content=_FailingContent(),
            ),
        )
        failing = ParserResultPublicationCommand(
            result=valid.result,
            markdown=valid.markdown,
            resources=(failing_resource,),
        )
        with self.assertRaises(ParserResultPublicationError):
            environment.adapter().publish_current(failing)
        self.assertEqual(environment.snapshot(), before)

    def test_every_publication_failpoint_preserves_the_complete_old_current(self) -> None:
        self.assertGreaterEqual(len(PARSER_RESULT_PUBLICATION_FAILPOINTS), 8)
        for offset, failpoint in enumerate(PARSER_RESULT_PUBLICATION_FAILPOINTS, start=30):
            with self.subTest(failpoint=failpoint):
                environment = self._environment(offset)
                old = _command(
                    environment.asset.asset_id,
                    environment.asset.sha256,
                    number=offset,
                    resources=(("images/old.png", b"\x89PNG\r\n\x1a\nold", "image/png"),),
                )
                new = _command(
                    environment.asset.asset_id,
                    environment.asset.sha256,
                    number=offset + 100,
                    resources=(("images/new.png", b"\x89PNG\r\n\x1a\nnew", "image/png"),),
                )
                environment.adapter().publish_current(old)
                before = environment.snapshot()

                with self.assertRaises(ParserResultPublicationError):
                    environment.adapter(failpoint=_fail_at(failpoint)).publish_current(new)

                self.assertEqual(environment.snapshot(), before)
                self.assertEqual(
                    environment.adapter().read_current(environment.asset.asset_id),
                    old.result,
                )

    def test_reparse_keeps_generation_lineage_content_and_content_ready_status(self) -> None:
        environment = self._environment(60)
        old = _command(environment.asset.asset_id, environment.asset.sha256, number=60)
        new = _command(environment.asset.asset_id, environment.asset.sha256, number=61)
        environment.adapter().publish_current(old)
        content = environment.publish_content(
            environment.literature,
            environment.asset,
            old.result,
            number=60,
        )
        environment.adapter().publish_current(new)
        detail = environment.reader.read_detail(environment.literature.literature_id)

        self.assertEqual(detail.parser_result, new.result)
        self.assertEqual(detail.content, content)
        self.assertEqual(detail.literature.status, LiteratureStatus.CONTENT_READY)
        self.assertIsNone(detail.missing_step)
        with environment.engine.read_snapshot() as connection:
            row = connection.execute(
                "SELECT parser_result_sha256,literature_content_sha256 "
                "FROM literature_contents WHERE literature_id=?",
                (environment.literature.literature_id.root,),
            ).fetchone()
        self.assertEqual(
            row,
            (old.result.result_sha256.root, content.literature_content_sha256.root),
        )

    def test_old_bytes_remain_readable_through_a_fixed_hash_during_replacement(self) -> None:
        environment = self._environment(70)
        old = _command(environment.asset.asset_id, environment.asset.sha256, number=70)
        new = _command(environment.asset.asset_id, environment.asset.sha256, number=71)
        environment.adapter().publish_current(old)
        old_reference = ArtifactReference(
            path=content_addressed_reference(
                old.result.markdown.sha256,
                old.result.markdown.byte_size,
            ),
            sha256=old.result.markdown.sha256,
            byte_size=old.result.markdown.byte_size,
            media_type=old.result.markdown.media_type,
        )
        read_context = environment.verified_reader.open(old_reference)
        stream = read_context.__enter__()
        with old.markdown.content.open() as expected_stream:
            expected = expected_stream.read()
        try:
            environment.adapter().publish_current(new)
            self.assertEqual(stream.read(), expected)
        finally:
            read_context.__exit__(None, None, None)

    def test_cleanup_keeps_artifacts_referenced_by_other_parser_rows_and_resources(self) -> None:
        environment = self._environment(80)
        _other_literature, other_asset = environment.add_primary(81)
        shared_markdown = b"# Shared parser Markdown\n\n![shared](files/shared.txt)\n"
        shared_resource = b"shared parser resource"
        first = _command(
            environment.asset.asset_id,
            environment.asset.sha256,
            number=80,
            markdown_payload=shared_markdown,
            resources=(("files/shared.txt", shared_resource, "text/plain"),),
        )
        second = _command(
            other_asset.asset_id,
            other_asset.sha256,
            number=81,
            markdown_payload=shared_markdown,
            resources=(("files/shared.txt", shared_resource, "text/plain"),),
        )
        environment.adapter().publish_current(first)
        environment.adapter().publish_current(second)
        shared_paths = {
            content_addressed_reference(
                first.result.markdown.sha256,
                first.result.markdown.byte_size,
            ),
            content_addressed_reference(
                first.result.resources[0].artifact.sha256,
                first.result.resources[0].artifact.byte_size,
            ),
        }

        environment.adapter().publish_current(
            _command(environment.asset.asset_id, environment.asset.sha256, number=82)
        )

        with environment.engine.read_snapshot() as connection:
            for path in shared_paths:
                self.assertIsNotNone(
                    connection.execute(
                        "SELECT 1 FROM artifact_objects WHERE relative_path=?",
                        (path.root,),
                    ).fetchone()
                )

    def test_cleanup_keeps_artifacts_referenced_by_asset_or_content(self) -> None:
        environment = self._environment(90)
        content_markdown = environment.content_markdown(environment.literature, number=90)
        asset_payload = b"shared supplementary artifact"
        old = _command(
            environment.asset.asset_id,
            environment.asset.sha256,
            number=90,
            markdown_payload=content_markdown,
            resources=(("files/shared.txt", asset_payload, "text/plain"),),
        )
        environment.adapter().publish_current(old)
        resource = old.result.resources[0].artifact
        resource_path = content_addressed_reference(resource.sha256, resource.byte_size)
        environment.writer.publish_asset(
            Asset(
                asset_id=AssetId(_uuid(909090)),
                sha256=resource.sha256,
                size_bytes=resource.byte_size,
                media_type=resource.media_type,
                path=resource_path,
            )
        )
        environment.publish_content(
            environment.literature,
            environment.asset,
            old.result,
            number=90,
            markdown_bytes=content_markdown,
        )
        markdown_path = content_addressed_reference(
            old.result.markdown.sha256,
            old.result.markdown.byte_size,
        )

        environment.adapter().publish_current(
            _command(environment.asset.asset_id, environment.asset.sha256, number=91)
        )

        with environment.engine.read_snapshot() as connection:
            for path in (resource_path, markdown_path):
                self.assertIsNotNone(
                    connection.execute(
                        "SELECT 1 FROM artifact_objects WHERE relative_path=?",
                        (path.root,),
                    ).fetchone()
                )

    def test_schema_has_generation_lineage_without_a_current_parser_foreign_key(self) -> None:
        environment = self._environment(100)
        with environment.engine.read_snapshot() as connection:
            foreign_targets = {
                str(row[2])
                for row in connection.execute(
                    'PRAGMA foreign_key_list("literature_contents")'
                ).fetchall()
            }
            columns = {
                str(row[1])
                for row in connection.execute('PRAGMA table_info("literature_contents")')
            }
        self.assertIn("parser_result_sha256", columns)
        self.assertNotIn("parser_results", foreign_targets)

    def test_literature_writer_is_not_a_second_parser_result_business_writer(self) -> None:
        self.assertFalse(hasattr(LiteratureWriter, "publish_parser_result"))


if __name__ == "__main__":
    unittest.main()
