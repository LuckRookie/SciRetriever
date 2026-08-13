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
    ReferencePublicationCommand,
    StalePreconditionError,
    content_reference_closure_token,
)
from sciretriever.literature.references import decide_content_replacement_cleanup
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
    ContentReferenceTextSupport,
    Identifier,
    Literature,
    LiteratureStatus,
    MetaLiterature,
    Reference,
    ReferenceSupport,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.parsing import (
    ParserArtifactRef,
    ParserProvenance,
    ParserResult,
    parser_result_sha256,
)
from sciretriever.model.primitives import (
    AssetId,
    LiteratureAssetId,
    LiteratureId,
    MetaLiteratureId,
    ProvenanceId,
    ReferenceId,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.parsing.ports import (
    ParserResultPublicationCommand,
    StagedParserArtifact,
)
from sciretriever.storage.files.paths import StorageRoot, content_addressed_reference
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactReference, ArtifactStore
from sciretriever.storage.sqlite.artifacts import register_artifact
from sciretriever.storage.sqlite.content_publication import (
    CONTENT_PUBLICATION_FAILPOINTS,
    ContentPublicationError,
    SqliteContentPublication,
)
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.literature_reader import LiteratureReader
from sciretriever.storage.sqlite.literature_writer import LiteratureWriter
from sciretriever.storage.sqlite.parsing_publication import SqliteParserResultPublication

_TIME = UtcTimestamp("2026-08-12T12:00:00Z")


def _uuid(number: int) -> str:
    return f"00000000-0000-4000-8000-{number:012x}"


class _BytesContent:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.open_count = 0

    @contextmanager
    def open(self) -> Generator[io.BytesIO, None, None]:
        self.open_count += 1
        stream = io.BytesIO(self.payload)
        try:
            yield stream
        finally:
            stream.close()


class _SensitiveFailureContent:
    def __init__(self, message: str) -> None:
        self.message = message

    @contextmanager
    def open(self) -> Generator[io.BytesIO, None, None]:
        if self.message:
            raise RuntimeError(self.message)
        yield io.BytesIO()


def _metadata(number: int, *, final: bool = False) -> LiteratureMetadata:
    return LiteratureMetadata(
        title=f"{'Final' if final else 'Initial'} content {number}",
        abstract=f"Accepted abstract {number}." if final else None,
        publication_year=2026,
        identifiers=(Identifier(namespace="doi", value=f"10.1000/content-{number}"),),
        keywords=("atomic", "content") if final else (),
    )


def _literature(number: int) -> Literature:
    return Literature(
        literature_id=LiteratureId(_uuid(1000 + number)),
        meta_literature_id=MetaLiteratureId(_uuid(2000 + number)),
        version_role=VersionRole.OTHER,
        metadata=_metadata(number),
        status=LiteratureStatus.UNREVIEWED,
    )


def _fail_at(expected: str) -> Callable[[str], None]:
    def checkpoint(name: str) -> None:
        if name == expected:
            raise RuntimeError("injected content publication failure")

    return checkpoint


class _Environment:
    def __init__(self, number: int) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-content-publication-")
        self.base = Path(self.temporary.name)
        self.artifact_directory = self.base / "artifacts"
        self.root = StorageRoot(self.artifact_directory)
        self.engine = CatalogEngine(self.base / "catalog.sqlite")
        self.store = ArtifactStore(self.root)
        self.reader = VerifiedReader(self.root)
        self.writer = LiteratureWriter(self.engine)
        self.query = LiteratureReader(self.engine, self.reader)
        self.literature = self.add_literature(number)
        self.asset = self.add_primary(self.literature, number)
        self.parser_result = self.publish_parser(number)

    def cleanup(self) -> None:
        self.temporary.cleanup()

    def adapter(
        self,
        *,
        failpoint: Callable[[str], None] | None = None,
    ) -> SqliteContentPublication:
        return SqliteContentPublication(
            self.engine,
            self.store,
            self.reader,
            failpoint=failpoint,
        )

    def add_literature(self, number: int) -> Literature:
        literature = _literature(number)
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
        return literature

    def publish_bytes(
        self,
        payload: bytes,
        media_type: str,
        *,
        artifact_id: str | None = None,
    ) -> ArtifactReference:
        reference = self.store.publish(
            payload,
            sha256=sha256_digest(payload),
            byte_size=len(payload),
            media_type=media_type,
        )
        if artifact_id is not None:
            with self.reader.acquire(reference) as lease:
                register_artifact(self.engine, artifact_id, lease)
        return reference

    def add_primary(self, literature: Literature, number: int) -> Asset:
        pdf = self.publish_bytes(
            f"%PDF-1.7\ncontent-{number}\n".encode(),
            "application/pdf",
            artifact_id=f"content-primary-{number}",
        )
        asset = Asset(
            asset_id=AssetId(_uuid(3000 + number)),
            sha256=pdf.sha256,
            size_bytes=pdf.byte_size,
            media_type=pdf.media_type,
            path=pdf.path,
        )
        self.writer.publish_asset(asset)
        self.attach_primary(literature, asset, number)
        return asset

    def attach_primary(self, literature: Literature, asset: Asset, number: int) -> None:
        self.writer.publish_literature_asset(
            LiteratureAsset(
                literature_asset_id=LiteratureAssetId(_uuid(4000 + number)),
                literature_id=literature.literature_id,
                asset_id=asset.asset_id,
                role=AssetRole.PRIMARY_PDF,
                provenance=Provenance(
                    provenance_id=ProvenanceId(_uuid(5000 + number)),
                    source_kind=SourceKind.ASSET_PROVIDER,
                    source_name="content-fixture-assets",
                    source_record_id=f"asset-{number}",
                    observed_at=_TIME,
                    input_sha256=asset.sha256,
                    parameters_sha256=None,
                ),
            )
        )

    def publish_parser(self, number: int) -> ParserResult:
        payload = f"# Parser input {number}\n".encode()
        staged = StagedParserArtifact(
            artifact=ParserArtifactRef(
                sha256=sha256_digest(payload),
                media_type="text/markdown",
                byte_size=len(payload),
            ),
            content=_BytesContent(payload),
        )
        provenance = ParserProvenance(
            provenance=Provenance(
                provenance_id=ProvenanceId(_uuid(6000 + number)),
                source_kind=SourceKind.PARSER,
                source_name="content-fixture-parser",
                source_record_id=None,
                observed_at=_TIME,
                input_sha256=self.asset.sha256,
                parameters_sha256=sha256_digest(f"parser-{number}".encode()),
            ),
            parser_version="1.0",
            mode="offline",
            model_identity=None,
        )
        result = ParserResult(
            source_asset_id=self.asset.asset_id,
            source_sha256=self.asset.sha256,
            page_count=1,
            markdown=staged.artifact,
            resources=(),
            result_sha256=parser_result_sha256(
                source_asset_id=self.asset.asset_id,
                source_sha256=self.asset.sha256,
                page_count=1,
                markdown=staged.artifact,
                resources=(),
                provenance=provenance,
            ),
            provenance=provenance,
        )
        SqliteParserResultPublication(self.engine, self.store, self.reader).publish_current(
            ParserResultPublicationCommand(
                result=result,
                markdown=staged,
                resources=(),
            )
        )
        return result

    @staticmethod
    def sections(number: int) -> tuple[LiteratureSection, ...]:
        return tuple(
            LiteratureSection(role=role, markdown=f"Accepted {number}: {role.value}.")
            for role in (
                LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
                LiteratureSectionRole.METHODS,
                LiteratureSectionRole.DATA,
                LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
            )
        )

    def command(
        self,
        *,
        literature: Literature | None = None,
        number: int,
        expected_revision: int,
        output_revision: int,
        current_metadata: LiteratureMetadata | None = None,
        old_content: LiteratureContent | None = None,
        references: tuple[Reference, ...] = (),
        supports: tuple[ReferenceSupport, ...] = (),
        markdown_bytes: bytes | None = None,
        publish_markdown: bool = True,
        provenance: Provenance | None = None,
    ) -> ContentPublicationCommand:
        target = self.literature if literature is None else literature
        input_metadata = target.metadata if current_metadata is None else current_metadata
        final_metadata = _metadata(number, final=True)
        metadata_hash = metadata_sha256(final_metadata)
        sections = self.sections(number)
        reference_texts = (f"Reference text {number}.",)
        actual_markdown = (
            markdown_bytes
            if markdown_bytes is not None
            else render_canonical_markdown(
                metadata=final_metadata,
                sections=sections,
                references=reference_texts,
            )
        )
        markdown_descriptor = ArtifactRef(
            sha256=sha256_digest(actual_markdown),
            media_type="text/markdown",
            byte_size=len(actual_markdown),
        )
        if publish_markdown:
            published = self.publish_bytes(actual_markdown, "text/markdown")
            if (
                published.sha256 != markdown_descriptor.sha256
                or published.byte_size != markdown_descriptor.byte_size
            ):
                raise AssertionError("Markdown fixture publication mismatch")
        analysis_provenance = provenance or Provenance(
            provenance_id=ProvenanceId(_uuid(7000 + number)),
            source_kind=SourceKind.ANALYSIS,
            source_name="content-fixture-analysis/model",
            source_record_id=None,
            observed_at=_TIME,
            input_sha256=analysis_input_sha256(
                self.asset.sha256,
                self.parser_result.result_sha256,
                metadata_hash,
            ),
            parameters_sha256=sha256_digest(f"analysis-{number}".encode()),
        )
        content = LiteratureContent(
            literature_content_sha256=content_sha256(
                metadata_sha256=metadata_hash,
                sections=sections,
                references=reference_texts,
            ),
            metadata_revision=output_revision,
            metadata_sha256=metadata_hash,
            sections=sections,
            references=reference_texts,
            markdown=markdown_descriptor,
            provenance=analysis_provenance,
        )
        replacement = ContentAcceptanceReplacement(
            literature_id=target.literature_id,
            metadata=final_metadata,
            metadata_revision=output_revision,
            metadata_sha256=metadata_hash,
            content=content,
        )
        cleanup = None
        closure = None
        if (
            old_content is not None
            and old_content.literature_content_sha256 != content.literature_content_sha256
        ):
            cleanup = decide_content_replacement_cleanup(
                source_literature_id=target.literature_id,
                old_content_sha256=old_content.literature_content_sha256,
                references=references,
                supports=supports,
            )
            if cleanup.decision not in {"cleaned", "unchanged"}:
                raise AssertionError("fixture cleanup must not be rejected")
            closure = content_reference_closure_token(
                target.literature_id,
                references,
                supports,
            )
        structured_bytes = canonical_literature_content_json(content)
        return ContentPublicationCommand(
            expected_token=LiteratureIdentityToken(
                literature_id=target.literature_id,
                meta_literature_id=target.meta_literature_id,
                metadata_revision=expected_revision,
                metadata_sha256=metadata_sha256(input_metadata),
            ),
            expected_primary_asset_id=self.asset.asset_id,
            expected_primary_pdf_sha256=self.asset.sha256,
            expected_parser_result_sha256=self.parser_result.result_sha256,
            replacement=replacement,
            structured_artifact=literature_content_artifact(content),
            structured_content=_BytesContent(structured_bytes),
            cleanup=cleanup,
            expected_reference_closure_token=closure,
        )

    def add_content_reference(
        self,
        content: LiteratureContent,
        *,
        number: int,
    ) -> tuple[Reference, ReferenceSupport]:
        target = self.add_literature(800 + number)
        reference = Reference(
            reference_id=ReferenceId(_uuid(8000 + number)),
            source_literature_id=self.literature.literature_id,
            target_literature_id=target.literature_id,
        )
        support = ReferenceSupport(
            reference_id=reference.reference_id,
            source=ContentReferenceTextSupport(
                kind="content_reference_text",
                literature_content_sha256=content.literature_content_sha256,
                reference_index=0,
            ),
        )
        self.writer.publish_reference(
            ReferencePublicationCommand(
                source_token=self.token(
                    self.literature,
                    content.metadata_revision,
                    self.query.read_detail(self.literature.literature_id).literature.metadata,
                ),
                target_token=self.token(target, 1, target.metadata),
                reference=reference,
                supports=(support,),
            )
        )
        return reference, support

    @staticmethod
    def token(
        literature: Literature,
        revision: int,
        metadata: LiteratureMetadata,
    ) -> LiteratureIdentityToken:
        return LiteratureIdentityToken(
            literature_id=literature.literature_id,
            meta_literature_id=literature.meta_literature_id,
            metadata_revision=revision,
            metadata_sha256=metadata_sha256(metadata),
        )

    def snapshot(self) -> tuple[object, ...]:
        tables = (
            "literatures",
            "literature_metadata",
            "literature_metadata_authors",
            "literature_metadata_author_affiliations",
            "literature_metadata_identifiers",
            "literature_metadata_keywords",
            "literature_fallback_identity_indexes",
            "literature_contents",
            "literature_content_reference_texts",
            "literature_references",
            "content_reference_text_supports",
            "literature_search_fts",
            "artifact_objects",
            "provenances",
        )
        with self.engine.read_snapshot() as connection:
            return tuple(
                tuple(connection.execute(f'SELECT * FROM "{table}" ORDER BY rowid'))
                for table in tables
            )

    def artifact_file(self, descriptor: ArtifactRef) -> Path:
        reference = content_addressed_reference(
            descriptor.sha256,
            descriptor.byte_size,
        )
        return self.artifact_directory / reference.root

    def catalog_artifact(self, descriptor: ArtifactRef) -> tuple[object, ...] | None:
        reference = content_addressed_reference(
            descriptor.sha256,
            descriptor.byte_size,
        )
        with self.engine.read_snapshot() as connection:
            row = connection.execute(
                "SELECT sha256,byte_size,media_type,relative_path "
                "FROM artifact_objects WHERE relative_path=?",
                (reference.root,),
            ).fetchone()
        return None if row is None else tuple(row)

    def catalog_provenance(self, provenance_id: ProvenanceId) -> tuple[object, ...] | None:
        with self.engine.read_snapshot() as connection:
            row = connection.execute(
                "SELECT * FROM provenances WHERE provenance_id=?",
                (provenance_id.root,),
            ).fetchone()
        return None if row is None else tuple(row)


class StorageContentPublicationContractTests(unittest.TestCase):
    def environment(self, number: int) -> _Environment:
        environment = _Environment(number)
        self.addCleanup(environment.cleanup)
        return environment

    def test_one_public_composite_adapter_owns_content_publication(self) -> None:
        self.assertIn("structured_content", ContentPublicationCommand.model_fields)
        self.assertEqual(
            CONTENT_PUBLICATION_FAILPOINTS,
            (
                "after-artifact-publication",
                "after-lease-prepare",
                "after-artifact-registration",
                "after-cas",
                "after-metadata-replacement",
                "after-cleanup",
                "after-binding",
                "after-orphan-catalog-cleanup",
                "before-commit",
            ),
        )
        self.assertTrue(callable(SqliteContentPublication.publish_content))
        self.assertFalse(hasattr(LiteratureWriter, "publish_content"))

    def test_first_acceptance_rehashes_and_registers_both_artifacts(self) -> None:
        environment = self.environment(1)
        command = environment.command(
            number=11,
            expected_revision=1,
            output_revision=2,
        )
        structured_bytes = canonical_literature_content_json(command.replacement.content)

        environment.adapter().publish_content(command)

        detail = environment.query.read_detail(environment.literature.literature_id)
        self.assertEqual(detail.metadata_revision, 2)
        self.assertEqual(detail.literature.metadata, command.replacement.metadata)
        self.assertEqual(detail.content, command.replacement.content)
        descriptors_and_bytes = (
            (command.structured_artifact, structured_bytes),
            (
                command.replacement.content.markdown,
                environment.artifact_file(command.replacement.content.markdown).read_bytes(),
            ),
        )
        for descriptor, expected_bytes in descriptors_and_bytes:
            with self.subTest(media_type=descriptor.media_type):
                physical_bytes = environment.artifact_file(descriptor).read_bytes()
                self.assertEqual(physical_bytes, expected_bytes)
                self.assertEqual(sha256_digest(physical_bytes), descriptor.sha256)
                self.assertEqual(len(physical_bytes), descriptor.byte_size)
                self.assertEqual(
                    environment.catalog_artifact(descriptor),
                    (
                        descriptor.sha256.root,
                        descriptor.byte_size,
                        descriptor.media_type,
                        content_addressed_reference(
                            descriptor.sha256,
                            descriptor.byte_size,
                        ).root,
                    ),
                )
        capability = command.structured_content
        if not isinstance(capability, _BytesContent):
            self.fail("fixture structured capability type changed")
        self.assertEqual(capability.open_count, 1)

    def test_failed_transaction_retries_same_bytes_without_replacing_inodes(self) -> None:
        environment = self.environment(2)
        command = environment.command(
            number=12,
            expected_revision=1,
            output_revision=2,
        )
        markdown_file = environment.artifact_file(command.replacement.content.markdown)
        markdown_inode = os.stat(markdown_file).st_ino
        baseline = environment.snapshot()

        with self.assertRaises(ContentPublicationError):
            environment.adapter(failpoint=_fail_at("before-commit")).publish_content(command)

        structured_file = environment.artifact_file(command.structured_artifact)
        self.assertTrue(structured_file.is_file())
        structured_inode = os.stat(structured_file).st_ino
        self.assertEqual(environment.snapshot(), baseline)
        self.assertIsNone(environment.catalog_artifact(command.structured_artifact))
        self.assertIsNone(environment.catalog_artifact(command.replacement.content.markdown))

        environment.adapter().publish_content(command)

        self.assertEqual(os.stat(structured_file).st_ino, structured_inode)
        self.assertEqual(os.stat(markdown_file).st_ino, markdown_inode)
        capability = command.structured_content
        if not isinstance(capability, _BytesContent):
            self.fail("fixture structured capability type changed")
        self.assertEqual(capability.open_count, 2)
        self.assertEqual(
            environment.query.read_detail(environment.literature.literature_id).content,
            command.replacement.content,
        )

    def test_structured_stream_or_descriptor_mismatch_fails_closed(self) -> None:
        environment = self.environment(3)
        command = environment.command(
            number=13,
            expected_revision=1,
            output_revision=2,
        )
        canonical = canonical_literature_content_json(command.replacement.content)
        same_size_wrong_hash = bytes((canonical[0] ^ 1,)) + canonical[1:]
        foreign_bytes = b'{"foreign":"structured-content"}'
        foreign_descriptor = ArtifactRef(
            sha256=sha256_digest(foreign_bytes),
            media_type="application/json",
            byte_size=len(foreign_bytes),
        )
        invalid_commands = (
            (
                "hash",
                command.model_copy(
                    update={"structured_content": _BytesContent(same_size_wrong_hash)}
                ),
            ),
            (
                "size",
                command.model_copy(update={"structured_content": _BytesContent(canonical + b"x")}),
            ),
            (
                "descriptor",
                command.model_copy(
                    update={
                        "structured_artifact": foreign_descriptor,
                        "structured_content": _BytesContent(foreign_bytes),
                    }
                ),
            ),
        )
        baseline = environment.snapshot()

        for mismatch, invalid in invalid_commands:
            with self.subTest(mismatch=mismatch):
                with self.assertRaises(ContentPublicationError) as captured:
                    environment.adapter().publish_content(invalid)
                self.assertNotIn(str(environment.base), str(captured.exception))
                self.assertEqual(environment.snapshot(), baseline)
                self.assertIsNone(environment.catalog_artifact(invalid.structured_artifact))

    def test_public_error_discards_sensitive_stream_exception_chain(self) -> None:
        environment = self.environment(31)
        command = environment.command(
            number=131,
            expected_revision=1,
            output_revision=2,
        )
        private_path = environment.base / "private-user-catalog.sqlite"
        private_bytes = b"private-user-literature-bytes"
        sensitive_values = (str(private_path), repr(private_bytes))
        invalid = command.model_copy(
            update={
                "structured_content": _SensitiveFailureContent(f"{private_path}: {private_bytes!r}")
            }
        )
        baseline = environment.snapshot()

        with self.assertRaises(ContentPublicationError) as captured:
            environment.adapter().publish_content(invalid)

        error = captured.exception
        self.assertEqual(str(error), "content publication failed")
        self.assertIsNone(error.__cause__)
        self.assertIsNone(error.__context__)
        exposed = (str(error), repr(error), repr(error.__cause__), repr(error.__context__))
        for sensitive in sensitive_values:
            for value in exposed:
                self.assertNotIn(sensitive, value)
        self.assertEqual(environment.snapshot(), baseline)

    def test_missing_markdown_fails_closed_without_catalog_rows(self) -> None:
        environment = self.environment(4)
        command = environment.command(
            number=14,
            expected_revision=1,
            output_revision=2,
            publish_markdown=False,
        )
        baseline = environment.snapshot()
        self.assertFalse(environment.artifact_file(command.replacement.content.markdown).exists())

        with self.assertRaises(ContentPublicationError) as captured:
            environment.adapter().publish_content(command)

        self.assertNotIn(str(environment.base), str(captured.exception))
        self.assertEqual(environment.snapshot(), baseline)
        self.assertIsNone(environment.catalog_artifact(command.structured_artifact))
        self.assertIsNone(environment.catalog_artifact(command.replacement.content.markdown))

    def test_same_size_tampered_markdown_fails_closed(self) -> None:
        environment = self.environment(5)
        command = environment.command(
            number=15,
            expected_revision=1,
            output_revision=2,
        )
        markdown_file = environment.artifact_file(command.replacement.content.markdown)
        original = markdown_file.read_bytes()
        tampered = bytes((original[0] ^ 1,)) + original[1:]
        markdown_file.write_bytes(tampered)
        self.assertEqual(markdown_file.stat().st_size, len(original))
        baseline = environment.snapshot()

        with self.assertRaises(ContentPublicationError) as captured:
            environment.adapter().publish_content(command)

        self.assertNotIn(str(environment.base), str(captured.exception))
        self.assertEqual(environment.snapshot(), baseline)
        self.assertIsNone(environment.catalog_artifact(command.structured_artifact))
        self.assertIsNone(environment.catalog_artifact(command.replacement.content.markdown))

    def test_stale_identity_primary_and_parser_preconditions_fail_closed(self) -> None:
        environment = self.environment(6)
        command = environment.command(
            number=16,
            expected_revision=1,
            output_revision=2,
        )
        token = command.expected_token
        stale_commands = (
            (
                "meta-literature",
                command.model_copy(
                    update={
                        "expected_token": token.model_copy(
                            update={"meta_literature_id": MetaLiteratureId(_uuid(900001))}
                        )
                    }
                ),
            ),
            (
                "metadata-revision",
                command.model_copy(
                    update={
                        "expected_token": token.model_copy(
                            update={"metadata_revision": token.metadata_revision + 1}
                        )
                    }
                ),
            ),
            (
                "metadata-hash",
                command.model_copy(
                    update={
                        "expected_token": token.model_copy(
                            update={"metadata_sha256": sha256_digest(b"stale-metadata")}
                        )
                    }
                ),
            ),
            (
                "primary-id",
                command.model_copy(update={"expected_primary_asset_id": AssetId(_uuid(900002))}),
            ),
            (
                "primary-hash",
                command.model_copy(
                    update={"expected_primary_pdf_sha256": sha256_digest(b"stale-primary")}
                ),
            ),
            (
                "parser-result",
                command.model_copy(
                    update={"expected_parser_result_sha256": sha256_digest(b"stale-parser")}
                ),
            ),
        )
        baseline = environment.snapshot()

        for precondition, stale in stale_commands:
            with self.subTest(precondition=precondition):
                with self.assertRaises(StalePreconditionError):
                    environment.adapter().publish_content(stale)
                self.assertEqual(environment.snapshot(), baseline)
                self.assertIsNone(environment.catalog_artifact(command.structured_artifact))

    def test_stale_reference_closure_fails_closed(self) -> None:
        environment = self.environment(7)
        old_command = environment.command(
            number=17,
            expected_revision=1,
            output_revision=2,
        )
        environment.adapter().publish_content(old_command)
        old_content = old_command.replacement.content
        first_reference, first_support = environment.add_content_reference(
            old_content,
            number=1,
        )
        stale = environment.command(
            number=18,
            expected_revision=2,
            output_revision=3,
            current_metadata=old_command.replacement.metadata,
            old_content=old_content,
            references=(first_reference,),
            supports=(first_support,),
        )
        environment.add_content_reference(old_content, number=2)
        baseline = environment.snapshot()

        with self.assertRaises(StalePreconditionError):
            environment.adapter().publish_content(stale)

        self.assertEqual(environment.snapshot(), baseline)
        self.assertEqual(
            environment.query.read_detail(environment.literature.literature_id).content,
            old_content,
        )
        self.assertIsNone(environment.catalog_artifact(stale.structured_artifact))

    def test_every_failpoint_rolls_back_the_complete_old_view(self) -> None:
        environment = self.environment(8)
        old_command = environment.command(
            number=19,
            expected_revision=1,
            output_revision=2,
        )
        environment.adapter().publish_content(old_command)
        old_content = old_command.replacement.content
        reference, support = environment.add_content_reference(old_content, number=3)
        replacement = environment.command(
            number=20,
            expected_revision=2,
            output_revision=3,
            current_metadata=old_command.replacement.metadata,
            old_content=old_content,
            references=(reference,),
            supports=(support,),
        )
        old_descriptors = (
            old_command.structured_artifact,
            old_content.markdown,
        )
        old_physical = tuple(
            environment.artifact_file(descriptor).read_bytes() for descriptor in old_descriptors
        )
        baseline = environment.snapshot()

        for failpoint in CONTENT_PUBLICATION_FAILPOINTS:
            with self.subTest(failpoint=failpoint):
                with self.assertRaises(ContentPublicationError):
                    environment.adapter(failpoint=_fail_at(failpoint)).publish_content(replacement)
                self.assertEqual(environment.snapshot(), baseline)
                detail = environment.query.read_detail(environment.literature.literature_id)
                self.assertEqual(detail.metadata_revision, 2)
                self.assertEqual(detail.content, old_content)
                for descriptor, expected in zip(
                    old_descriptors,
                    old_physical,
                    strict=True,
                ):
                    self.assertEqual(
                        environment.artifact_file(descriptor).read_bytes(),
                        expected,
                    )
                self.assertIsNone(environment.catalog_artifact(replacement.structured_artifact))
                self.assertIsNone(
                    environment.catalog_artifact(replacement.replacement.content.markdown)
                )
        capability = replacement.structured_content
        if not isinstance(capability, _BytesContent):
            self.fail("fixture structured capability type changed")
        self.assertEqual(capability.open_count, len(CONTENT_PUBLICATION_FAILPOINTS))

    def test_successful_replacement_removes_only_orphan_catalog_bindings(self) -> None:
        environment = self.environment(9)
        old_command = environment.command(
            number=21,
            expected_revision=1,
            output_revision=2,
        )
        environment.adapter().publish_content(old_command)
        old_content = old_command.replacement.content
        reference, support = environment.add_content_reference(old_content, number=4)
        old_descriptors = (old_command.structured_artifact, old_content.markdown)
        old_bytes = tuple(
            environment.artifact_file(descriptor).read_bytes() for descriptor in old_descriptors
        )
        replacement = environment.command(
            number=22,
            expected_revision=2,
            output_revision=3,
            current_metadata=old_command.replacement.metadata,
            old_content=old_content,
            references=(reference,),
            supports=(support,),
        )

        environment.adapter().publish_content(replacement)

        detail = environment.query.read_detail(environment.literature.literature_id)
        self.assertEqual(detail.metadata_revision, 3)
        self.assertEqual(detail.content, replacement.replacement.content)
        with environment.engine.read_snapshot() as connection:
            reference_count = connection.execute(
                "SELECT COUNT(*) FROM literature_references WHERE reference_id=?",
                (reference.reference_id.root,),
            ).fetchone()
            support_count = connection.execute(
                "SELECT COUNT(*) FROM content_reference_text_supports WHERE reference_id=?",
                (reference.reference_id.root,),
            ).fetchone()
        self.assertEqual(reference_count, (0,))
        self.assertEqual(support_count, (0,))
        for descriptor, expected in zip(old_descriptors, old_bytes, strict=True):
            self.assertIsNone(environment.catalog_artifact(descriptor))
            self.assertEqual(environment.artifact_file(descriptor).read_bytes(), expected)
        self.assertIsNone(environment.catalog_provenance(old_content.provenance.provenance_id))
        self.assertIsNotNone(environment.catalog_artifact(replacement.structured_artifact))
        self.assertIsNotNone(environment.catalog_artifact(replacement.replacement.content.markdown))

    def test_shared_old_artifacts_and_provenance_are_not_retired(self) -> None:
        environment = self.environment(10)
        old_command = environment.command(
            number=23,
            expected_revision=1,
            output_revision=2,
        )
        environment.adapter().publish_content(old_command)
        old_content = old_command.replacement.content
        second = environment.add_literature(24)
        environment.attach_primary(second, environment.asset, 24)
        shared_command = environment.command(
            literature=second,
            number=23,
            expected_revision=1,
            output_revision=2,
            current_metadata=second.metadata,
            provenance=old_content.provenance,
        )
        self.assertEqual(shared_command.replacement.content, old_content)
        environment.adapter().publish_content(shared_command)
        replacement = environment.command(
            number=25,
            expected_revision=2,
            output_revision=3,
            current_metadata=old_command.replacement.metadata,
            old_content=old_content,
        )

        environment.adapter().publish_content(replacement)

        self.assertEqual(
            environment.query.read_detail(second.literature_id).content,
            old_content,
        )
        self.assertIsNotNone(environment.catalog_artifact(old_command.structured_artifact))
        self.assertIsNotNone(environment.catalog_artifact(old_content.markdown))
        self.assertIsNotNone(environment.catalog_provenance(old_content.provenance.provenance_id))
        self.assertTrue(environment.artifact_file(old_command.structured_artifact).is_file())
        self.assertTrue(environment.artifact_file(old_content.markdown).is_file())


if __name__ == "__main__":
    unittest.main()
