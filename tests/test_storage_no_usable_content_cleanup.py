from __future__ import annotations

import threading
import unittest
from collections.abc import Callable
from contextlib import closing
from dataclasses import replace
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sciretriever.acquisition.ports import (
    AcquisitionExpectedFacts,
    ValidatedPrimaryPdfPublicationCommand,
)
from sciretriever.analysis.markdown import render_canonical_markdown
from sciretriever.entry.ports import (
    NoUsableContentCleanupCommand,
    NoUsableContentCleanupFailure,
)
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
    LiteratureObservation,
    ReferencePublicationCommand,
    ReferenceSupportAppendCommand,
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
    NoUsableContent,
    analysis_input_sha256,
    content_sha256,
)
from sciretriever.model.literature import (
    ContentReferenceTextSupport,
    Identifier,
    Literature,
    LiteratureStatus,
    MetadataReferenceTextSupport,
    MetaLiterature,
    Reference,
    ReferenceSupport,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
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
    ObservationId,
    ProvenanceId,
    ReferenceId,
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
from sciretriever.storage.files.paths import StorageRoot, content_addressed_reference
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.reconciliation import ArtifactStoreReconciler
from sciretriever.storage.files.store import ArtifactStore
from sciretriever.storage.sqlite.acquisition_publication import (
    SqliteAcquisitionPublication,
)
from sciretriever.storage.sqlite.artifact_references import SqliteArtifactReferenceStore
from sciretriever.storage.sqlite.artifacts import register_artifact
from sciretriever.storage.sqlite.content_publication import SqliteContentPublication
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.literature_writer import LiteratureWriter
from sciretriever.storage.sqlite.no_usable_content_cleanup import (
    NO_USABLE_CONTENT_CLEANUP_FAILPOINTS,
    SqliteNoUsableContentCleanup,
)
from sciretriever.storage.sqlite.parsing_publication import SqliteParserResultPublication

_TIME = UtcTimestamp("2026-08-12T16:00:00Z")


def _uuid(number: int) -> str:
    return f"90000000-0000-4000-8000-{number:012x}"


class _Environment:
    def __init__(
        self,
        *,
        manual: bool = False,
        with_resources: bool = False,
        with_content: bool = False,
    ) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-no-content-cleanup-")
        self.base = Path(self.temporary.name)
        self.root = StorageRoot(self.base / "artifacts")
        self.engine = CatalogEngine(self.base / "catalog.sqlite")
        self.store = ArtifactStore(self.root)
        self.reader = VerifiedReader(self.root)
        self.reconciler = ArtifactStoreReconciler(
            self.root,
            SqliteArtifactReferenceStore(self.engine),
        )
        self.writer = LiteratureWriter(self.engine)
        self.target_observations: dict[LiteratureId, MetadataObservation] = {}
        self.literature = self._add_literature()
        self.primary = self._add_primary(manual=manual)
        self.parser = self._add_parser(with_resources=with_resources)
        self.content = self._add_content() if with_content else None
        self.command = self._command()

    def cleanup(self) -> None:
        self.temporary.cleanup()

    def _add_literature(self) -> Literature:
        metadata = LiteratureMetadata(
            title="No usable content fixture",
            publication_year=2026,
            identifiers=(Identifier(namespace="doi", value="10.1000/no-content"),),
        )
        literature = Literature(
            literature_id=LiteratureId(_uuid(1)),
            meta_literature_id=MetaLiteratureId(_uuid(2)),
            version_role=VersionRole.OTHER,
            metadata=metadata,
            status=LiteratureStatus.UNREVIEWED,
        )
        self.main_observation = MetadataObservation(
            observation_id=ObservationId(_uuid(8)),
            provenance=Provenance(
                provenance_id=ProvenanceId(_uuid(9)),
                source_kind=SourceKind.METADATA_PROVIDER,
                source_name="fixture-metadata",
                source_record_id="main-record",
                observed_at=_TIME,
                input_sha256=Sha256("1" * 64),
                parameters_sha256=None,
            ),
            metadata=metadata,
            reference_texts=("Retained elsewhere.",),
        )
        self.writer.publish_identity_and_observation(
            IdentityObservationPublicationCommand(
                literatures=(literature,),
                meta_literatures=(
                    MetaLiterature(
                        meta_literature_id=literature.meta_literature_id,
                        representative_literature_id=literature.literature_id,
                    ),
                ),
                observations=(
                    LiteratureObservation(
                        literature_id=literature.literature_id,
                        observation=self.main_observation,
                    ),
                ),
                facts=(
                    CurrentLiteratureFacts(
                        literature=literature,
                        metadata_revision=1,
                        metadata_sha256=metadata_sha256(metadata),
                    ),
                ),
                expected_tokens=(),
                expected_meta_tokens=(),
            )
        )
        return literature

    def _add_primary(self, *, manual: bool):  # noqa: ANN202
        payload = b"%PDF-1.7\nno usable content\n"
        digest = sha256_digest(payload)
        source_kind = SourceKind.USER if manual else SourceKind.ASSET_PROVIDER
        provenance = Provenance(
            provenance_id=ProvenanceId(_uuid(3)),
            source_kind=source_kind,
            source_name="manual-pdf" if manual else "fixture-source",
            source_record_id=None if manual else "candidate-record",
            observed_at=_TIME,
            input_sha256=digest,
            parameters_sha256=None,
        )
        expected = AcquisitionExpectedFacts(
            literature_id=self.literature.literature_id,
            meta_literature_id=self.literature.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(self.literature.metadata),
            expected_no_primary_pdf=True,
        )
        command = ValidatedPrimaryPdfPublicationCommand(
            expected_facts=expected,
            proposed_artifact_id="cleanup-primary-artifact",
            proposed_asset_id=AssetId(_uuid(4)),
            proposed_literature_asset_id=LiteratureAssetId(_uuid(5)),
            provenance=provenance,
            source_url=None if manual else "https://offline.invalid/paper.pdf",
        )
        return SqliteAcquisitionPublication(
            self.engine,
            self.store,
            self.reader,
        ).commit_validated_primary_pdf(
            command,
            _ValidatedBytes(payload),
        )

    def _add_parser(self, *, with_resources: bool) -> ParserResult:
        payload = b"# Parser result\n"
        descriptor = ParserArtifactRef(
            sha256=sha256_digest(payload),
            media_type="text/markdown",
            byte_size=len(payload),
        )
        provenance = ParserProvenance(
            provenance=Provenance(
                provenance_id=ProvenanceId(_uuid(6)),
                source_kind=SourceKind.PARSER,
                source_name="fixture-parser",
                source_record_id=None,
                observed_at=_TIME,
                input_sha256=self.primary.asset.sha256,
                parameters_sha256=Sha256("f" * 64),
            ),
            parser_version="1",
        )
        resource_payload = b"offline image"
        resources = (
            (
                ParserResource(
                    reference="images/figure.png",
                    artifact=ParserArtifactRef(
                        sha256=sha256_digest(resource_payload),
                        media_type="image/png",
                        byte_size=len(resource_payload),
                    ),
                ),
            )
            if with_resources
            else ()
        )
        result = ParserResult(
            source_asset_id=self.primary.asset.asset_id,
            source_sha256=self.primary.asset.sha256,
            page_count=1,
            markdown=descriptor,
            resources=resources,
            result_sha256=parser_result_sha256(
                source_asset_id=self.primary.asset.asset_id,
                source_sha256=self.primary.asset.sha256,
                page_count=1,
                markdown=descriptor,
                resources=resources,
                provenance=provenance,
            ),
            provenance=provenance,
        )
        SqliteParserResultPublication(self.engine, self.store, self.reader).publish_current(
            ParserResultPublicationCommand(
                result=result,
                markdown=StagedParserArtifact(
                    artifact=descriptor,
                    content=_Bytes(payload),
                ),
                resources=tuple(
                    StagedParserResource(
                        reference=resource.reference,
                        artifact=StagedParserArtifact(
                            artifact=resource.artifact,
                            content=_Bytes(resource_payload),
                        ),
                    )
                    for resource in resources
                ),
            )
        )
        return result

    def _add_content(self) -> LiteratureContent:
        sections = tuple(
            LiteratureSection(role=role, markdown=f"Current body {role.value}.")
            for role in (
                LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
                LiteratureSectionRole.METHODS,
                LiteratureSectionRole.DATA,
                LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
            )
        )
        references = ("Only content support.", "Retained elsewhere.")
        markdown_payload = render_canonical_markdown(
            metadata=self.literature.metadata,
            sections=sections,
            references=references,
        )
        markdown = ArtifactRef(
            sha256=sha256_digest(markdown_payload),
            media_type="text/markdown",
            byte_size=len(markdown_payload),
        )
        published = self.store.publish(
            markdown_payload,
            sha256=markdown.sha256,
            byte_size=markdown.byte_size,
            media_type=markdown.media_type,
        )
        if published.path != content_addressed_reference(markdown.sha256, markdown.byte_size):
            raise AssertionError("unexpected content-addressed fixture path")
        provenance = Provenance(
            provenance_id=ProvenanceId(_uuid(7)),
            source_kind=SourceKind.ANALYSIS,
            source_name="fixture-analysis",
            source_record_id=None,
            observed_at=_TIME,
            input_sha256=analysis_input_sha256(
                self.primary.asset.sha256,
                self.parser.result_sha256,
                metadata_sha256(self.literature.metadata),
            ),
            parameters_sha256=Sha256("e" * 64),
        )
        content = LiteratureContent(
            literature_content_sha256=content_sha256(
                metadata_sha256=metadata_sha256(self.literature.metadata),
                sections=sections,
                references=references,
            ),
            metadata_revision=1,
            metadata_sha256=metadata_sha256(self.literature.metadata),
            sections=sections,
            references=references,
            markdown=markdown,
            provenance=provenance,
        )
        replacement = ContentAcceptanceReplacement(
            literature_id=self.literature.literature_id,
            metadata=self.literature.metadata,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(self.literature.metadata),
            content=content,
        )
        SqliteContentPublication(self.engine, self.store, self.reader).publish_content(
            ContentPublicationCommand(
                expected_token=self._token(self.literature),
                expected_primary_asset_id=self.primary.asset.asset_id,
                expected_primary_pdf_sha256=self.primary.asset.sha256,
                expected_parser_result_sha256=self.parser.result_sha256,
                replacement=replacement,
                structured_artifact=literature_content_artifact(content),
                structured_content=_Bytes(canonical_literature_content_json(content)),
                cleanup=None,
                expected_reference_closure_token=None,
            )
        )
        return content

    @staticmethod
    def _token(literature: Literature) -> LiteratureIdentityToken:
        return LiteratureIdentityToken(
            literature_id=literature.literature_id,
            meta_literature_id=literature.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(literature.metadata),
        )

    def _command(self) -> NoUsableContentCleanupCommand:
        references: tuple[Reference, ...] = ()
        supports: tuple[ReferenceSupport, ...] = ()
        if self.content is not None:
            references, supports = self._add_content_references(self.content)
        cleanup = (
            None
            if self.content is None
            else decide_content_replacement_cleanup(
                self.literature.literature_id,
                self.content.literature_content_sha256,
                references,
                supports,
            )
        )
        closure = (
            None
            if self.content is None
            else content_reference_closure_token(
                self.literature.literature_id,
                references,
                supports,
            )
        )
        return NoUsableContentCleanupCommand(
            decision=NoUsableContent(outcome="no_usable_content"),
            literature_id=self.literature.literature_id,
            meta_literature_id=self.literature.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(self.literature.metadata),
            primary_asset=self.primary.asset,
            primary_relation=self.primary.relation,
            parser_result=self.parser,
            current_content=self.content,
            current_content_lineage=(None if self.content is None else self._content_lineage()),
            reference_cleanup=cleanup,
            reference_closure_token=closure,
        )

    def _content_lineage(self):  # noqa: ANN202
        from sciretriever.literature.state import CurrentContentLineage

        return CurrentContentLineage(
            primary_asset_id=self.primary.asset.asset_id,
            primary_pdf_sha256=self.primary.asset.sha256,
            parser_result_sha256=self.parser.result_sha256,
        )

    def _add_content_references(
        self,
        content: LiteratureContent,
    ) -> tuple[tuple[Reference, ...], tuple[ReferenceSupport, ...]]:
        targets = (self._add_target(20), self._add_target(21))
        references = tuple(
            Reference(
                reference_id=ReferenceId(_uuid(30 + index)),
                source_literature_id=self.literature.literature_id,
                target_literature_id=target.literature_id,
            )
            for index, target in enumerate(targets)
        )
        supports = tuple(
            ReferenceSupport(
                reference_id=reference.reference_id,
                source=ContentReferenceTextSupport(
                    kind="content_reference_text",
                    literature_content_sha256=content.literature_content_sha256,
                    reference_index=index,
                ),
            )
            for index, reference in enumerate(references)
        )
        for target, reference, support in zip(targets, references, supports, strict=True):
            self.writer.publish_reference(
                ReferencePublicationCommand(
                    source_token=self._token(self.literature),
                    target_token=self._token(target),
                    reference=reference,
                    supports=(support,),
                )
            )
        self.content_references = references
        self.content_supports = supports
        self.content_targets = targets
        return references, supports

    def retain_second_reference_with_metadata_support(self) -> Reference:
        command = self.command
        content = command.current_content
        assert content is not None
        references = self.content_references
        retained = references[1]
        target = self.content_targets[1]
        support = ReferenceSupport(
            reference_id=retained.reference_id,
            source=MetadataReferenceTextSupport(
                kind="metadata_reference_text",
                metadata_observation_id=self.main_observation.observation_id,
                reference_index=0,
            ),
        )
        self.writer.append_reference_support(
            ReferenceSupportAppendCommand(
                source_token=self._token(self.literature),
                target_token=self._token(target),
                reference=retained,
                supports=(support,),
            )
        )
        supports = (*self.content_supports, support)
        self.command = replace(
            self.command,
            reference_cleanup=decide_content_replacement_cleanup(
                self.literature.literature_id,
                content.literature_content_sha256,
                references,
                supports,
            ),
            reference_closure_token=content_reference_closure_token(
                self.literature.literature_id,
                references,
                supports,
            ),
        )
        return retained

    def add_inbound_reference(self) -> Reference:
        source = self._add_target(91)
        reference = Reference(
            reference_id=ReferenceId(_uuid(92)),
            source_literature_id=source.literature_id,
            target_literature_id=self.literature.literature_id,
        )
        observation = self.target_observations[source.literature_id]
        support = ReferenceSupport(
            reference_id=reference.reference_id,
            source=MetadataReferenceTextSupport(
                kind="metadata_reference_text",
                metadata_observation_id=observation.observation_id,
                reference_index=0,
            ),
        )
        self.writer.publish_reference(
            ReferencePublicationCommand(
                source_token=self._token(source),
                target_token=self._token(self.literature),
                reference=reference,
                supports=(support,),
            )
        )
        return reference

    def _add_target(self, number: int) -> Literature:
        metadata = LiteratureMetadata(
            title=f"Cleanup target {number}",
            identifiers=(Identifier(namespace="doi", value=f"10.1000/target-{number}"),),
        )
        target = Literature(
            literature_id=LiteratureId(_uuid(100 + number)),
            meta_literature_id=MetaLiteratureId(_uuid(200 + number)),
            version_role=VersionRole.OTHER,
            metadata=metadata,
            status=LiteratureStatus.UNREVIEWED,
        )
        observation = MetadataObservation(
            observation_id=ObservationId(_uuid(300 + number)),
            provenance=Provenance(
                provenance_id=ProvenanceId(_uuid(400 + number)),
                source_kind=SourceKind.METADATA_PROVIDER,
                source_name="fixture-target-metadata",
                source_record_id=f"target-{number}",
                observed_at=_TIME,
                input_sha256=Sha256(f"{number % 16:x}" * 64),
                parameters_sha256=None,
            ),
            metadata=metadata,
            reference_texts=("Inbound target.",),
        )
        self.target_observations[target.literature_id] = observation
        self.writer.publish_identity_and_observation(
            IdentityObservationPublicationCommand(
                literatures=(target,),
                meta_literatures=(
                    MetaLiterature(
                        meta_literature_id=target.meta_literature_id,
                        representative_literature_id=target.literature_id,
                    ),
                ),
                observations=(
                    LiteratureObservation(
                        literature_id=target.literature_id,
                        observation=observation,
                    ),
                ),
                facts=(
                    CurrentLiteratureFacts(
                        literature=target,
                        metadata_revision=1,
                        metadata_sha256=metadata_sha256(metadata),
                    ),
                ),
                expected_tokens=(),
                expected_meta_tokens=(),
            )
        )
        return target

    def share_primary_asset(self) -> Literature:
        target = self._add_target(40)
        relation = LiteratureAsset(
            literature_asset_id=LiteratureAssetId(_uuid(41)),
            literature_id=target.literature_id,
            asset_id=self.primary.asset.asset_id,
            role=AssetRole.SUPPLEMENTARY_PDF,
            provenance=self.primary.relation.provenance,
            source_url=self.primary.relation.source_url,
        )
        self.writer.publish_literature_asset(relation)
        return target

    def share_artifact_as_asset(self, path: str, number: int) -> Asset:
        with self.engine.read_snapshot() as connection:
            row = connection.execute(
                "SELECT sha256,byte_size,media_type FROM artifact_objects WHERE relative_path=?",
                (path,),
            ).fetchone()
        if row is None:
            raise AssertionError("fixture artifact is missing")
        asset = Asset(
            asset_id=AssetId(_uuid(number)),
            sha256=Sha256(str(row[0])),
            size_bytes=int(row[1]),
            media_type=str(row[2]),
            path=content_addressed_reference(Sha256(str(row[0])), int(row[1])),
        )
        self.writer.publish_asset(asset)
        return asset

    def snapshot(self) -> tuple[tuple[str, tuple[tuple[object, ...], ...]], ...]:
        tables = (
            "literature_assets",
            "assets",
            "parser_results",
            "parser_result_resources",
            "artifact_objects",
            "provenances",
            "literature_contents",
            "literature_content_reference_texts",
            "content_reference_text_supports",
            "literature_references",
            "literature_search_fts",
        )
        with self.engine.read_snapshot() as connection:
            return tuple(
                (
                    table,
                    tuple(
                        tuple(row)
                        for row in connection.execute(f'SELECT * FROM "{table}" ORDER BY rowid')
                    ),
                )
                for table in tables
            )


class _Bytes:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload

    def open(self):  # noqa: ANN201
        return closing(BytesIO(self.payload))


class _ValidatedBytes:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.sha256 = sha256_digest(payload)
        self.byte_size = len(payload)
        self.media_type = "application/pdf"

    def open(self):  # noqa: ANN201
        return closing(BytesIO(self.payload))


def _fail_at(expected: str) -> Callable[[str], None]:
    def failpoint(name: str) -> None:
        if name == expected:
            raise RuntimeError("injected cleanup failure")

    return failpoint


class NoUsableContentCleanupStorageTests(unittest.TestCase):
    def environment(
        self,
        *,
        manual: bool = False,
        with_resources: bool = False,
        with_content: bool = False,
    ) -> _Environment:
        environment = _Environment(
            manual=manual,
            with_resources=with_resources,
            with_content=with_content,
        )
        self.addCleanup(environment.cleanup)
        return environment

    def test_automatic_and_manual_managed_primary_closures_are_removed(self) -> None:
        for manual in (False, True):
            with self.subTest(manual=manual):
                environment = self.environment(manual=manual)
                primary_file = environment.base / "artifacts" / environment.primary.asset.path.root
                self.assertTrue(primary_file.is_file())

                result = SqliteNoUsableContentCleanup(
                    environment.engine,
                ).cleanup_no_usable_content(environment.command)
                environment.reconciler.reconcile()

                self.assertEqual(result.literature_id, environment.literature.literature_id)
                self.assertEqual(result.primary_asset_id, environment.primary.asset.asset_id)
                with environment.engine.read_snapshot() as connection:
                    for table in ("literature_assets", "assets", "parser_results"):
                        self.assertEqual(
                            connection.execute(f"SELECT count(*) FROM {table}").fetchone(),
                            (0,),
                        )
                    self.assertEqual(
                        connection.execute(
                            "SELECT content_body FROM literature_search_fts WHERE literature_id=?",
                            (environment.literature.literature_id.root,),
                        ).fetchone(),
                        ("",),
                    )
                self.assertFalse(primary_file.exists())

    def test_parser_resources_and_current_content_reference_closure_are_removed(self) -> None:
        environment = self.environment(with_resources=True, with_content=True)
        content = environment.content
        assert content is not None
        resource = environment.parser.resources[0]
        physical_paths = tuple(
            environment.base / "artifacts" / path
            for path in (
                environment.primary.asset.path.root,
                content_addressed_reference(
                    environment.parser.markdown.sha256,
                    environment.parser.markdown.byte_size,
                ).root,
                content_addressed_reference(
                    resource.artifact.sha256,
                    resource.artifact.byte_size,
                ).root,
                content_addressed_reference(
                    content.markdown.sha256,
                    content.markdown.byte_size,
                ).root,
            )
        )
        self.assertTrue(all(path.is_file() for path in physical_paths))

        SqliteNoUsableContentCleanup(
            environment.engine,
        ).cleanup_no_usable_content(environment.command)
        environment.reconciler.reconcile()

        with environment.engine.read_snapshot() as connection:
            for table in (
                "literature_assets",
                "assets",
                "parser_results",
                "parser_result_resources",
                "literature_contents",
                "literature_content_reference_texts",
                "content_reference_text_supports",
                "literature_references",
            ):
                self.assertEqual(
                    connection.execute(f"SELECT count(*) FROM {table}").fetchone(),
                    (0,),
                )
            fts = connection.execute(
                "SELECT title,identifiers,content_body FROM literature_search_fts "
                "WHERE literature_id=?",
                (environment.literature.literature_id.root,),
            ).fetchone()
            self.assertEqual(
                fts,
                (
                    "no usable content fixture",
                    "doi\n10 1000 no content",
                    "",
                ),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT literature_id FROM literature_search_fts "
                    "WHERE literature_search_fts MATCH 'fixture'"
                ).fetchone(),
                (environment.literature.literature_id.root,),
            )
            self.assertIsNone(
                connection.execute(
                    "SELECT literature_id FROM literature_search_fts "
                    "WHERE literature_search_fts MATCH 'background'"
                ).fetchone()
            )
        self.assertTrue(all(not path.exists() for path in physical_paths))

    def test_shared_asset_artifacts_and_provenances_are_retained(self) -> None:
        environment = self.environment(with_resources=True, with_content=True)
        content = environment.content
        assert content is not None
        environment.share_primary_asset()
        parser_path = content_addressed_reference(
            environment.parser.markdown.sha256,
            environment.parser.markdown.byte_size,
        ).root
        resource_path = content_addressed_reference(
            environment.parser.resources[0].artifact.sha256,
            environment.parser.resources[0].artifact.byte_size,
        ).root
        structured = literature_content_artifact(content)
        structured_path = content_addressed_reference(
            structured.sha256,
            structured.byte_size,
        ).root
        markdown_path = content_addressed_reference(
            content.markdown.sha256,
            content.markdown.byte_size,
        ).root
        shared_paths = (parser_path, resource_path, structured_path, markdown_path)
        shared_physical_paths = (
            environment.base / "artifacts" / environment.primary.asset.path.root,
            *(environment.base / "artifacts" / path for path in shared_paths),
        )
        self.assertTrue(all(path.is_file() for path in shared_physical_paths))
        shared_assets = tuple(
            environment.share_artifact_as_asset(path, 50 + index)
            for index, path in enumerate(shared_paths)
        )
        with environment.engine.write_transaction() as connection:
            for provenance_id, observation_id in (
                (
                    environment.parser.provenance.provenance.provenance_id.root,
                    _uuid(60),
                ),
                (content.provenance.provenance_id.root, _uuid(61)),
            ):
                connection.execute(
                    "INSERT INTO provider_relation_observations(observation_id,provenance_id) "
                    "VALUES(?,?)",
                    (observation_id, provenance_id),
                )

        SqliteNoUsableContentCleanup(
            environment.engine,
        ).cleanup_no_usable_content(environment.command)
        environment.reconciler.reconcile()

        with environment.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM assets WHERE asset_id=?",
                    (environment.primary.asset.asset_id.root,),
                ).fetchone(),
                (1,),
            )
            for asset, path in zip(shared_assets, shared_paths, strict=True):
                self.assertEqual(
                    connection.execute(
                        "SELECT relative_path FROM assets WHERE asset_id=?",
                        (asset.asset_id.root,),
                    ).fetchone(),
                    (path,),
                )
                self.assertEqual(
                    connection.execute(
                        "SELECT count(*) FROM artifact_objects WHERE relative_path=?",
                        (path,),
                    ).fetchone(),
                    (1,),
                )
            for provenance_id in (
                environment.primary.relation.provenance.provenance_id,
                environment.parser.provenance.provenance.provenance_id,
                content.provenance.provenance_id,
            ):
                self.assertEqual(
                    connection.execute(
                        "SELECT count(*) FROM provenances WHERE provenance_id=?",
                        (provenance_id.root,),
                    ).fetchone(),
                    (1,),
                )
        self.assertTrue(all(path.is_file() for path in shared_physical_paths))

    def test_other_support_and_inbound_reference_are_retained(self) -> None:
        environment = self.environment(with_content=True)
        retained = environment.retain_second_reference_with_metadata_support()
        inbound = environment.add_inbound_reference()

        SqliteNoUsableContentCleanup(
            environment.engine,
        ).cleanup_no_usable_content(environment.command)
        environment.reconciler.reconcile()

        with environment.engine.read_snapshot() as connection:
            remaining = connection.execute(
                "SELECT reference_id,source_literature_id,target_literature_id "
                "FROM literature_references ORDER BY reference_id"
            ).fetchall()
            self.assertEqual(
                remaining,
                [
                    (
                        retained.reference_id.root,
                        retained.source_literature_id.root,
                        retained.target_literature_id.root,
                    ),
                    (
                        inbound.reference_id.root,
                        inbound.source_literature_id.root,
                        inbound.target_literature_id.root,
                    ),
                ],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT reference_id FROM metadata_reference_text_supports "
                    "ORDER BY reference_id"
                ).fetchall(),
                [(retained.reference_id.root,), (inbound.reference_id.root,)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM content_reference_text_supports"
                ).fetchone(),
                (0,),
            )

    def test_stale_closure_matrix_and_concurrent_replay_are_atomic(self) -> None:
        environment = self.environment(with_resources=True, with_content=True)
        command = environment.command
        content = command.current_content
        lineage = command.current_content_lineage
        reference_cleanup = command.reference_cleanup
        token = command.reference_closure_token
        assert content is not None
        assert lineage is not None
        assert reference_cleanup is not None
        assert token is not None
        other_meta = MetaLiteratureId(_uuid(870))
        changed_asset_id = AssetId(_uuid(800))
        changed_asset = command.primary_asset.model_copy(update={"asset_id": changed_asset_id})
        changed_relation_asset = command.primary_relation.model_copy(
            update={"asset_id": changed_asset_id}
        )
        changed_parser_asset = command.parser_result.model_copy(
            update={"source_asset_id": changed_asset_id}
        )
        changed_asset_lineage = lineage.model_copy(update={"primary_asset_id": changed_asset_id})
        changed_pdf_sha = Sha256("a" * 64)
        changed_pdf_asset = command.primary_asset.model_copy(update={"sha256": changed_pdf_sha})
        changed_pdf_parser = command.parser_result.model_copy(
            update={"source_sha256": changed_pdf_sha}
        )
        changed_pdf_lineage = lineage.model_copy(update={"primary_pdf_sha256": changed_pdf_sha})
        changed_result_sha = Sha256("b" * 64)
        changed_result_parser = command.parser_result.model_copy(
            update={"result_sha256": changed_result_sha}
        )
        changed_result_lineage = lineage.model_copy(
            update={"parser_result_sha256": changed_result_sha}
        )
        changed_primary_provenance = command.primary_relation.provenance.model_copy(
            update={"source_name": "changed-source"}
        )
        changed_parser_provenance = command.parser_result.provenance.model_copy(
            update={
                "provenance": command.parser_result.provenance.provenance.model_copy(
                    update={"source_name": "changed-parser"}
                )
            }
        )
        changed_content_sha = Sha256("c" * 64)
        stale_commands = (
            replace(command, meta_literature_id=other_meta),
            replace(
                command,
                primary_asset=changed_asset,
                primary_relation=changed_relation_asset,
                parser_result=changed_parser_asset,
                current_content_lineage=changed_asset_lineage,
            ),
            replace(
                command,
                primary_asset=changed_pdf_asset,
                parser_result=changed_pdf_parser,
                current_content_lineage=changed_pdf_lineage,
            ),
            replace(
                command,
                primary_relation=command.primary_relation.model_copy(
                    update={"literature_asset_id": LiteratureAssetId(_uuid(801))}
                ),
            ),
            replace(
                command,
                primary_relation=command.primary_relation.model_copy(
                    update={"source_url": "https://offline.invalid/changed.pdf"}
                ),
            ),
            replace(
                command,
                primary_relation=command.primary_relation.model_copy(
                    update={"provenance": changed_primary_provenance}
                ),
            ),
            replace(
                command,
                parser_result=changed_result_parser,
                current_content_lineage=changed_result_lineage,
            ),
            replace(
                command,
                parser_result=command.parser_result.model_copy(update={"resources": ()}),
            ),
            replace(
                command,
                parser_result=command.parser_result.model_copy(
                    update={"provenance": changed_parser_provenance}
                ),
            ),
            replace(
                command,
                current_content=content.model_copy(
                    update={"literature_content_sha256": changed_content_sha}
                ),
                reference_cleanup=reference_cleanup.model_copy(
                    update={"old_content_sha256": changed_content_sha}
                ),
            ),
            replace(
                command,
                reference_closure_token=token.model_copy(
                    update={"closure_sha256": Sha256("d" * 64)}
                ),
            ),
        )
        baseline = environment.snapshot()
        for stale_command in stale_commands:
            with self.subTest(stale_command=stale_command):
                with self.assertRaises(NoUsableContentCleanupFailure) as caught:
                    SqliteNoUsableContentCleanup(
                        environment.engine,
                    ).cleanup_no_usable_content(stale_command)
                self.assertEqual(caught.exception.failure.code, "no-usable-content-cleanup-stale")
                self.assertEqual(environment.snapshot(), baseline)

        for statement, parameter_factory in (
            (
                "UPDATE literature_contents SET parser_result_sha256=? WHERE literature_id=?",
                lambda isolated: (
                    "e" * 64,
                    isolated.literature.literature_id.root,
                ),
            ),
            (
                "UPDATE literature_content_reference_texts SET reference_text='changed' "
                "WHERE literature_content_sha256=? AND reference_index=0",
                lambda isolated: (isolated.content.literature_content_sha256.root,),
            ),
            (
                "UPDATE literature_search_fts SET content_body='changed' WHERE literature_id=?",
                lambda isolated: (isolated.literature.literature_id.root,),
            ),
        ):
            with self.subTest(statement=statement):
                isolated = self.environment(with_resources=True, with_content=True)
                assert isolated.content is not None
                with isolated.engine.write_transaction() as connection:
                    connection.execute(statement, parameter_factory(isolated))
                changed_baseline = isolated.snapshot()
                with self.assertRaises(NoUsableContentCleanupFailure) as caught:
                    SqliteNoUsableContentCleanup(
                        isolated.engine,
                    ).cleanup_no_usable_content(isolated.command)
                self.assertEqual(caught.exception.failure.code, "no-usable-content-cleanup-stale")
                self.assertEqual(isolated.snapshot(), changed_baseline)

        environment = self.environment(with_resources=True, with_content=True)
        barrier = threading.Barrier(2)
        outcomes: list[str] = []
        unexpected: list[str] = []

        def run_cleanup() -> None:
            barrier.wait()
            try:
                SqliteNoUsableContentCleanup(
                    environment.engine,
                ).cleanup_no_usable_content(environment.command)
            except NoUsableContentCleanupFailure as error:
                outcomes.append(error.failure.code)
            except Exception as error:  # pragma: no cover - assertion reports exact type
                unexpected.append(type(error).__name__)
            else:
                outcomes.append("committed")

        threads = tuple(threading.Thread(target=run_cleanup) for _ in range(2))
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(unexpected, [])
        self.assertEqual(
            sorted(outcomes),
            ["committed", "no-usable-content-cleanup-stale"],
        )
        with environment.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM parser_results").fetchone(),
                (0,),
            )

    def test_stale_and_repeat_cleanup_leave_catalog_unchanged(self) -> None:
        environment = self.environment()
        stale = replace(environment.command, metadata_sha256=Sha256("a" * 64))
        baseline = environment.snapshot()
        with self.assertRaises(NoUsableContentCleanupFailure) as caught:
            SqliteNoUsableContentCleanup(
                environment.engine,
            ).cleanup_no_usable_content(stale)
        self.assertEqual(caught.exception.failure.code, "no-usable-content-cleanup-stale")
        self.assertEqual(environment.snapshot(), baseline)

        adapter = SqliteNoUsableContentCleanup(environment.engine)
        adapter.cleanup_no_usable_content(environment.command)
        committed = environment.snapshot()
        with self.assertRaises(NoUsableContentCleanupFailure) as repeated:
            adapter.cleanup_no_usable_content(environment.command)
        self.assertEqual(repeated.exception.failure.code, "no-usable-content-cleanup-stale")
        self.assertEqual(environment.snapshot(), committed)

    def test_committed_cleanup_defers_physical_recovery_without_command_replay(
        self,
    ) -> None:
        environment = self.environment(with_resources=True)
        environment.share_primary_asset()
        primary_path = environment.base / "artifacts" / environment.primary.asset.path.root
        parser_orphans = (
            content_addressed_reference(
                environment.parser.markdown.sha256,
                environment.parser.markdown.byte_size,
            ),
            *(
                content_addressed_reference(
                    resource.artifact.sha256,
                    resource.artifact.byte_size,
                )
                for resource in environment.parser.resources
            ),
        )
        parser_paths = tuple(
            environment.base / "artifacts" / reference.root for reference in parser_orphans
        )
        self.assertTrue(primary_path.is_file())
        self.assertTrue(all(path.is_file() for path in parser_paths))

        with patch.object(ArtifactStoreReconciler, "_reconcile") as reconcile:
            SqliteNoUsableContentCleanup(environment.engine).cleanup_no_usable_content(
                environment.command
            )
        reconcile.assert_not_called()
        with environment.engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM literature_assets").fetchone(),
                (1,),
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM parser_results").fetchone(),
                (0,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM artifact_objects WHERE relative_path=?",
                    (
                        content_addressed_reference(
                            environment.parser.markdown.sha256,
                            environment.parser.markdown.byte_size,
                        ).root,
                    ),
                ).fetchone(),
                (0,),
            )
        self.assertTrue(primary_path.is_file())
        self.assertTrue(all(path.is_file() for path in parser_paths))

        with self.assertRaises(NoUsableContentCleanupFailure) as replay:
            SqliteNoUsableContentCleanup(
                environment.engine,
            ).cleanup_no_usable_content(environment.command)
        self.assertEqual(replay.exception.failure.code, "no-usable-content-cleanup-stale")

        recovered = environment.reconciler.reconcile()
        self.assertEqual(set(recovered.deleted), set(parser_orphans))
        self.assertTrue(all(not path.exists() for path in parser_paths))
        self.assertTrue(primary_path.is_file())
        rerun = environment.reconciler.reconcile()
        self.assertEqual(rerun.deleted, ())
        self.assertIn(environment.primary.asset.path, rerun.preserved)

    def test_cleanup_does_not_reconcile_another_targets_publication_window(self) -> None:
        environment = self.environment()
        payload = b"parallel analysis markdown awaiting Literature acceptance"
        pending = environment.store.publish(
            payload,
            sha256=sha256_digest(payload),
            byte_size=len(payload),
            media_type="text/markdown",
        )
        pending_path = environment.base / "artifacts" / pending.path.root
        self.assertTrue(pending_path.is_file())

        with patch.object(ArtifactStoreReconciler, "reconcile_admitted") as reconcile:
            SqliteNoUsableContentCleanup(environment.engine).cleanup_no_usable_content(
                environment.command
            )
        reconcile.assert_not_called()
        self.assertTrue(pending_path.is_file())

        with environment.reader.lease(pending) as lease:
            register_artifact(environment.engine, "parallel-analysis-markdown", lease)
        environment.share_artifact_as_asset(pending.path.root, 875)
        result = environment.reconciler.reconcile()

        self.assertIn(pending.path, result.preserved)
        self.assertTrue(pending_path.is_file())
        primary_path = environment.base / "artifacts" / environment.primary.asset.path.root
        self.assertFalse(primary_path.exists())

    def test_every_transaction_failpoint_rolls_back_the_complete_catalog(self) -> None:
        for number, failpoint in enumerate(NO_USABLE_CONTENT_CLEANUP_FAILPOINTS, start=1):
            with self.subTest(failpoint=failpoint):
                environment = self.environment(manual=bool(number % 2))
                baseline = environment.snapshot()
                with self.assertRaises(NoUsableContentCleanupFailure):
                    SqliteNoUsableContentCleanup(
                        environment.engine,
                        failpoint=_fail_at(failpoint),
                    ).cleanup_no_usable_content(environment.command)
                self.assertEqual(environment.snapshot(), baseline)


if __name__ == "__main__":
    unittest.main()
