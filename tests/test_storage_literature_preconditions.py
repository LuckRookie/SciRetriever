from __future__ import annotations

import ast
import io
import json
import os
import sqlite3
import threading
import unittest
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

import sciretriever.literature.content as literature_content
import sciretriever.literature.ports as literature_ports
import sciretriever.literature.references as literature_references
import sciretriever.literature.state as literature_state
import sciretriever.storage.sqlite.literature_preconditions as literature_preconditions
import sciretriever.storage.sqlite.literature_writer as literature_writer
from sciretriever.analysis.markdown import render_canonical_markdown
from sciretriever.literature.content import (
    ContentAcceptanceReplacement,
    canonical_literature_content_json,
    literature_content_artifact,
    metadata_sha256,
)
from sciretriever.literature.ports import (
    ContentPublicationCommand,
    ContentReadRequest,
    CurrentFactsReadRequest,
    DeletionReadRequest,
    FallbackIdentityIndex,
    IdentityObservationPublicationCommand,
    IdentityReadRequest,
    LiteratureIdentityToken,
    LiteratureObservation,
    ProviderRecordReadKey,
    ReferencePublicationCommand,
    ReferenceReadRequest,
    UserObservationIndex,
    VersionLinkReadKey,
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
    Author,
    AuthorKind,
    Identifier,
    Literature,
    LiteratureStatus,
    MetadataReferenceTextSupport,
    MetaLiterature,
    ProviderRelationSupport,
    Reference,
    ReferenceSupport,
    VersionRole,
)
from sciretriever.model.metadata import (
    LiteratureMetadata,
    MetadataObservation,
    ProviderLiteratureKey,
    ProviderRelationObservation,
)
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
)
from sciretriever.storage.files.paths import StorageRoot, content_addressed_reference
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactReference, ArtifactStore
from sciretriever.storage.sqlite.artifacts import register_artifact
from sciretriever.storage.sqlite.content_publication import SqliteContentPublication
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.literature_preconditions import (
    LiteraturePreconditionReader,
    LiteraturePreconditionReadError,
)
from sciretriever.storage.sqlite.literature_writer import LiteratureWriter
from sciretriever.storage.sqlite.parsing_publication import SqliteParserResultPublication

_TIMESTAMP = UtcTimestamp("2026-08-11T08:00:00Z")
_PARAMETERS_SHA256 = Sha256("f" * 64)
_REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


class _ParserBytes:
    __slots__ = ("_payload",)

    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    @contextmanager
    def open(self) -> Generator[io.BytesIO, None, None]:
        stream = io.BytesIO(self._payload)
        try:
            yield stream
        finally:
            stream.close()


class _StructuredContent:
    __slots__ = ("_payload",)

    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    @contextmanager
    def open(self) -> Generator[io.BytesIO, None, None]:
        stream = io.BytesIO(self._payload)
        try:
            yield stream
        finally:
            stream.close()

    def __repr__(self) -> str:
        return "<_StructuredContent>"


def _literature_import_paths(module_path: Path) -> tuple[str, ...]:
    tree = ast.parse(module_path.read_text(encoding="utf-8"), filename=str(module_path))
    paths: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.module is not None and (
                node.module == "sciretriever.literature"
                or node.module.startswith("sciretriever.literature.")
            ):
                paths.append(node.module)
        elif isinstance(node, ast.Import):
            paths.extend(
                alias.name
                for alias in node.names
                if alias.name == "sciretriever.literature"
                or alias.name.startswith("sciretriever.literature.")
            )
    return tuple(sorted(paths))


class StorageLiteratureAdapterBoundaryTests(unittest.TestCase):
    def test_adapters_import_literature_only_through_its_ports(self) -> None:
        for relative_path in (
            "src/sciretriever/storage/sqlite/literature_preconditions.py",
            "src/sciretriever/storage/sqlite/literature_writer.py",
        ):
            with self.subTest(relative_path=relative_path):
                paths = _literature_import_paths(_REPOSITORY_ROOT / relative_path)
                self.assertTrue(paths)
                self.assertEqual(set(paths), {"sciretriever.literature.ports"})

    def test_adapter_facing_exports_preserve_authoritative_object_identity(self) -> None:
        authoritative_objects = {
            "ContentAcceptanceReplacement": literature_content.ContentAcceptanceReplacement,
            "ReferenceCleanupDecision": literature_references.ReferenceCleanupDecision,
            "CurrentLiteratureFacts": literature_state.CurrentLiteratureFacts,
            "CurrentPrimaryPdf": literature_state.CurrentPrimaryPdf,
            "metadata_sha256": literature_content.metadata_sha256,
            "canonical_literature_content_json": (
                literature_content.canonical_literature_content_json
            ),
            "literature_content_artifact": literature_content.literature_content_artifact,
            "analysis_input_sha256": analysis_input_sha256,
            "derive_status": literature_state.derive_status,
        }
        self.assertFalse(hasattr(literature_state, "analysis_input_sha256"))
        for name, authoritative_object in authoritative_objects.items():
            with self.subTest(name=name):
                exported_object = getattr(literature_ports, name)
                self.assertIs(exported_object, authoritative_object)
                for adapter in (literature_preconditions, literature_writer):
                    if hasattr(adapter, name):
                        self.assertIs(getattr(adapter, name), exported_object)


class _CountingCatalogEngine(CatalogEngine):
    read_snapshot_calls: int
    _pause: tuple[threading.Event, threading.Event] | None

    def __init__(self, catalog_path: Path) -> None:
        super().__init__(catalog_path, create=False)
        object.__setattr__(self, "read_snapshot_calls", 0)
        object.__setattr__(self, "_pause", None)

    def pause_next_snapshot(
        self,
        entered: threading.Event,
        release: threading.Event,
    ) -> None:
        object.__setattr__(self, "_pause", (entered, release))

    @contextmanager
    def read_snapshot(self) -> Generator[sqlite3.Connection, None, None]:
        object.__setattr__(self, "read_snapshot_calls", self.read_snapshot_calls + 1)
        with super().read_snapshot() as connection:
            pause = self._pause
            if pause is not None:
                object.__setattr__(self, "_pause", None)
                # BEGIN is deferred.  This first relational read fixes the WAL
                # snapshot before the concurrent writer is released.
                connection.execute("SELECT count(*) FROM literatures").fetchone()
                entered, release = pause
                entered.set()
                if not release.wait(timeout=5):
                    raise RuntimeError("timed out waiting to release read snapshot")
            yield connection


def _uuid(number: int) -> str:
    return f"00000000-0000-4000-8000-{number:012x}"


def _metadata(
    title: str,
    *,
    identifiers: tuple[Identifier, ...] = (),
) -> LiteratureMetadata:
    return LiteratureMetadata(
        title=title,
        authors=(
            Author(
                kind=AuthorKind.PERSON,
                display_name="Ada Lovelace",
                given_name="Ada",
                family_name="Lovelace",
            ),
        ),
        abstract=f"Abstract for {title}",
        publication_year=2026,
        document_type="journal-article",
        language="en",
        venue="Fixture Journal",
        publisher="Fixture Publisher",
        identifiers=identifiers,
        keywords=("fixture",),
    )


def _provenance(
    number: int,
    *,
    kind: SourceKind,
    source_name: str,
    record_id: str | None,
    input_sha256: Sha256 | None,
    parameters_sha256: Sha256 | None = None,
) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(_uuid(number)),
        source_kind=kind,
        source_name=source_name,
        source_record_id=record_id,
        observed_at=_TIMESTAMP,
        input_sha256=input_sha256,
        parameters_sha256=parameters_sha256,
    )


def _literature(
    number: int,
    *,
    meta_number: int | None = None,
    title: str | None = None,
    identifiers: tuple[Identifier, ...] = (),
) -> Literature:
    return Literature(
        literature_id=LiteratureId(_uuid(number)),
        meta_literature_id=MetaLiteratureId(_uuid(number if meta_number is None else meta_number)),
        version_role=VersionRole.OTHER,
        metadata=_metadata(title or f"Literature {number}", identifiers=identifiers),
        status=LiteratureStatus.UNREVIEWED,
    )


def _provider_observation(
    number: int,
    metadata: LiteratureMetadata,
    *,
    source_name: str = "fixture-provider",
    record_id: str | None = None,
    reference_texts: tuple[str, ...] = (),
) -> MetadataObservation:
    actual_record_id = record_id or f"record-{number}"
    return MetadataObservation(
        observation_id=ObservationId(_uuid(number)),
        provenance=_provenance(
            number,
            kind=SourceKind.METADATA_PROVIDER,
            source_name=source_name,
            record_id=actual_record_id,
            input_sha256=sha256_digest(actual_record_id.encode()),
        ),
        metadata=metadata,
        reference_texts=reference_texts,
    )


def _user_observation(number: int, metadata: LiteratureMetadata) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_uuid(number)),
        provenance=_provenance(
            number,
            kind=SourceKind.USER,
            source_name="bibliographic-import",
            record_id=None,
            input_sha256=None,
        ),
        metadata=metadata,
    )


class LiteraturePreconditionReaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-literature-read-")
        self.addCleanup(self.temporary.cleanup)
        temporary_path = Path(self.temporary.name)
        self.engine = CatalogEngine(temporary_path / "catalog.sqlite")
        self.writer = LiteratureWriter(self.engine)
        self.storage_root = StorageRoot(temporary_path / "artifacts")
        self.artifact_store = ArtifactStore(self.storage_root)
        self.verified_reader = VerifiedReader(self.storage_root)
        self.reader = LiteraturePreconditionReader(self.engine, self.verified_reader)
        self.parser_publication = SqliteParserResultPublication(
            self.engine,
            self.artifact_store,
            self.verified_reader,
        )
        self.content_publication = SqliteContentPublication(
            self.engine,
            self.artifact_store,
            self.verified_reader,
        )

    def _publish_identities(
        self,
        literatures: tuple[Literature, ...],
        *,
        observations: tuple[LiteratureObservation, ...] = (),
        fallback_indexes: tuple[FallbackIdentityIndex, ...] = (),
        user_indexes: tuple[UserObservationIndex, ...] = (),
    ) -> None:
        representatives: dict[MetaLiteratureId, LiteratureId] = {}
        for literature in literatures:
            representatives.setdefault(
                literature.meta_literature_id,
                literature.literature_id,
            )
        self.writer.publish_identity_and_observation(
            IdentityObservationPublicationCommand(
                literatures=literatures,
                meta_literatures=tuple(
                    MetaLiterature(
                        meta_literature_id=meta_id,
                        representative_literature_id=representative,
                    )
                    for meta_id, representative in representatives.items()
                ),
                observations=observations,
                facts=tuple(
                    CurrentLiteratureFacts(
                        literature=literature,
                        metadata_revision=1,
                        metadata_sha256=metadata_sha256(literature.metadata),
                    )
                    for literature in literatures
                ),
                expected_tokens=(),
                expected_meta_tokens=(),
                fallback_identity_indexes=fallback_indexes,
                user_observation_indexes=user_indexes,
            )
        )

    def _publish_artifact(
        self,
        payload: bytes,
        *,
        media_type: str,
        artifact_id: str,
    ) -> ArtifactReference:
        reference = self.artifact_store.publish(
            payload,
            sha256=sha256_digest(payload),
            byte_size=len(payload),
            media_type=media_type,
        )
        with self.verified_reader.acquire(reference) as lease:
            register_artifact(self.engine, artifact_id, lease)
        return reference

    @staticmethod
    def _token(literature: Literature) -> LiteratureIdentityToken:
        return LiteratureIdentityToken(
            literature_id=literature.literature_id,
            meta_literature_id=literature.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(literature.metadata),
        )

    def _publish_complete_content(
        self,
        literature: Literature,
    ) -> tuple[LiteratureContent, ArtifactReference, bytes]:
        pdf = self._publish_artifact(
            b"%PDF-1.7\nfixture\n",
            media_type="application/pdf",
            artifact_id="fixture-pdf",
        )
        parser_payload = b"# Parsed fixture\n"
        parser_markdown = self._publish_artifact(
            parser_payload,
            media_type="text/markdown",
            artifact_id="fixture-parser-markdown",
        )
        asset_id = AssetId(_uuid(70))
        self.writer.publish_asset(
            Asset(
                asset_id=asset_id,
                sha256=pdf.sha256,
                size_bytes=pdf.byte_size,
                media_type=pdf.media_type,
                path=pdf.path,
            )
        )
        self.writer.publish_literature_asset(
            LiteratureAsset(
                literature_asset_id=LiteratureAssetId(_uuid(71)),
                literature_id=literature.literature_id,
                asset_id=asset_id,
                role=AssetRole.PRIMARY_PDF,
                provenance=_provenance(
                    72,
                    kind=SourceKind.ASSET_PROVIDER,
                    source_name="fixture-assets",
                    record_id="asset-record",
                    input_sha256=pdf.sha256,
                ),
            )
        )
        parser_provenance = ParserProvenance(
            provenance=_provenance(
                73,
                kind=SourceKind.PARSER,
                source_name="fixture-parser",
                record_id=None,
                input_sha256=pdf.sha256,
                parameters_sha256=_PARAMETERS_SHA256,
            ),
            parser_version="1.0",
            mode="offline",
        )
        parser_descriptor = ParserArtifactRef(
            sha256=parser_markdown.sha256,
            media_type=parser_markdown.media_type,
            byte_size=parser_markdown.byte_size,
        )
        parser_hash = parser_result_sha256(
            source_asset_id=asset_id,
            source_sha256=pdf.sha256,
            page_count=1,
            markdown=parser_descriptor,
            resources=(),
            provenance=parser_provenance,
        )
        parser_result = ParserResult(
            source_asset_id=asset_id,
            source_sha256=pdf.sha256,
            page_count=1,
            markdown=parser_descriptor,
            result_sha256=parser_hash,
            provenance=parser_provenance,
        )
        self.parser_publication.publish_current(
            ParserResultPublicationCommand(
                result=parser_result,
                markdown=StagedParserArtifact(
                    artifact=parser_descriptor,
                    content=_ParserBytes(parser_payload),
                ),
                resources=(),
            )
        )

        sections = tuple(
            LiteratureSection(role=role, markdown=f"Body for {role.value}")
            for role in (
                LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
                LiteratureSectionRole.METHODS,
                LiteratureSectionRole.DATA,
                LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
            )
        )
        references = ("A cited fixture.",)
        canonical_markdown = render_canonical_markdown(
            metadata=literature.metadata,
            sections=sections,
            references=references,
        )
        markdown = self.artifact_store.publish(
            canonical_markdown,
            sha256=sha256_digest(canonical_markdown),
            byte_size=len(canonical_markdown),
            media_type="text/markdown",
        )
        metadata_digest = metadata_sha256(literature.metadata)
        content = LiteratureContent(
            literature_content_sha256=content_sha256(
                metadata_sha256=metadata_digest,
                sections=sections,
                references=references,
            ),
            metadata_revision=1,
            metadata_sha256=metadata_digest,
            sections=sections,
            references=references,
            markdown=ArtifactRef(
                sha256=markdown.sha256,
                byte_size=markdown.byte_size,
                media_type=markdown.media_type,
            ),
            provenance=_provenance(
                74,
                kind=SourceKind.ANALYSIS,
                source_name="fixture-analysis",
                record_id=None,
                input_sha256=analysis_input_sha256(
                    pdf.sha256,
                    parser_result.result_sha256,
                    metadata_digest,
                ),
                parameters_sha256=_PARAMETERS_SHA256,
            ),
        )
        encoded = canonical_literature_content_json(content)
        structured_descriptor = literature_content_artifact(content)
        self.content_publication.publish_content(
            ContentPublicationCommand(
                expected_token=LiteratureIdentityToken(
                    literature_id=literature.literature_id,
                    meta_literature_id=literature.meta_literature_id,
                    metadata_revision=1,
                    metadata_sha256=metadata_digest,
                ),
                expected_primary_asset_id=asset_id,
                expected_primary_pdf_sha256=pdf.sha256,
                expected_parser_result_sha256=parser_result.result_sha256,
                replacement=ContentAcceptanceReplacement(
                    literature_id=literature.literature_id,
                    metadata=literature.metadata,
                    metadata_revision=1,
                    metadata_sha256=metadata_digest,
                    content=content,
                ),
                structured_artifact=structured_descriptor,
                structured_content=_StructuredContent(encoded),
            )
        )
        structured = ArtifactReference(
            path=content_addressed_reference(
                structured_descriptor.sha256,
                structured_descriptor.byte_size,
            ),
            sha256=structured_descriptor.sha256,
            byte_size=structured_descriptor.byte_size,
            media_type=structured_descriptor.media_type,
        )
        return content, structured, encoded

    def test_identity_returns_every_stable_and_hash_collision_candidate(self) -> None:
        stable_a = Identifier(namespace="doi", value="10.1000/a")
        stable_b = Identifier(namespace="pmid", value="200")
        literature_a = _literature(1, identifiers=(stable_a,))
        literature_b = _literature(2, identifiers=(stable_b,))
        literature_c = _literature(3)
        literature_d = _literature(4)
        observation_c1 = _user_observation(20, literature_c.metadata)
        observation_c2 = _user_observation(21, literature_c.metadata)
        observation_d = _user_observation(22, literature_d.metadata)
        collision = Sha256("c" * 64)
        self._publish_identities(
            (literature_a, literature_b, literature_c, literature_d),
            observations=(
                LiteratureObservation(
                    literature_id=literature_c.literature_id,
                    observation=observation_c1,
                ),
                LiteratureObservation(
                    literature_id=literature_c.literature_id,
                    observation=observation_c2,
                ),
                LiteratureObservation(
                    literature_id=literature_d.literature_id,
                    observation=observation_d,
                ),
            ),
            fallback_indexes=(
                FallbackIdentityIndex(
                    literature_id=literature_a.literature_id,
                    fallback_identity_sha256=collision,
                ),
                FallbackIdentityIndex(
                    literature_id=literature_b.literature_id,
                    fallback_identity_sha256=collision,
                ),
            ),
            user_indexes=(
                UserObservationIndex(
                    observation_id=observation_c1.observation_id,
                    semantic_sha256=collision,
                ),
                UserObservationIndex(
                    observation_id=observation_c2.observation_id,
                    semantic_sha256=collision,
                ),
                UserObservationIndex(
                    observation_id=observation_d.observation_id,
                    semantic_sha256=collision,
                ),
            ),
        )

        context = self.reader.read_identity(
            IdentityReadRequest(
                observation_id=ObservationId(_uuid(999)),
                stable_identifier_keys=(
                    (stable_a.namespace, stable_a.value),
                    (stable_b.namespace, stable_b.value),
                ),
                fallback_identity_sha256=collision,
                user_observation_semantic_sha256=collision,
            )
        )

        self.assertEqual(
            {item.literature_id for item in context.literatures},
            {
                literature_a.literature_id,
                literature_b.literature_id,
                literature_c.literature_id,
                literature_d.literature_id,
            },
        )
        self.assertEqual(len(context.meta_literatures), 4)
        self.assertEqual(len(context.facts), 4)
        self.assertEqual(
            {
                (item.literature_id, item.observation.observation_id)
                for item in context.observations
            },
            {
                (literature_c.literature_id, observation_c1.observation_id),
                (literature_c.literature_id, observation_c2.observation_id),
                (literature_d.literature_id, observation_d.observation_id),
            },
        )

    def test_provider_record_key_returns_all_owners_in_scope_from_one_snapshot(self) -> None:
        first_owner = _literature(120)
        second_owner = _literature(121)
        other_provider_owner = _literature(122)
        first_observation = _provider_observation(
            130,
            first_owner.metadata,
            source_name="provider-a",
            record_id="shared-record",
        )
        second_observation_same_owner = _provider_observation(
            131,
            first_owner.metadata,
            source_name="provider-a",
            record_id="shared-record",
        )
        second_owner_observation = _provider_observation(
            132,
            second_owner.metadata,
            source_name="provider-a",
            record_id="shared-record",
        )
        other_provider_observation = _provider_observation(
            133,
            other_provider_owner.metadata,
            source_name="provider-b",
            record_id="shared-record",
        )
        self._publish_identities(
            (first_owner, second_owner, other_provider_owner),
            observations=(
                LiteratureObservation(
                    literature_id=first_owner.literature_id,
                    observation=first_observation,
                ),
                LiteratureObservation(
                    literature_id=first_owner.literature_id,
                    observation=second_observation_same_owner,
                ),
                LiteratureObservation(
                    literature_id=second_owner.literature_id,
                    observation=second_owner_observation,
                ),
                LiteratureObservation(
                    literature_id=other_provider_owner.literature_id,
                    observation=other_provider_observation,
                ),
            ),
        )
        counting_engine = _CountingCatalogEngine(self.engine.catalog_path)
        reader = LiteraturePreconditionReader(counting_engine, self.verified_reader)

        context = reader.read_identity(
            IdentityReadRequest(
                observation_id=ObservationId(_uuid(999)),
                provider_record_key=ProviderRecordReadKey(
                    source_name="provider-a",
                    source_record_id="shared-record",
                ),
            )
        )

        self.assertEqual(counting_engine.read_snapshot_calls, 1)
        self.assertEqual(
            {item.literature_id for item in context.literatures},
            {first_owner.literature_id, second_owner.literature_id},
        )
        self.assertEqual(
            {
                (item.literature_id, item.observation.observation_id)
                for item in context.observations
            },
            {
                (first_owner.literature_id, first_observation.observation_id),
                (
                    first_owner.literature_id,
                    second_observation_same_owner.observation_id,
                ),
                (second_owner.literature_id, second_owner_observation.observation_id),
            },
        )

        one_owner = reader.read_identity(
            IdentityReadRequest(
                observation_id=ObservationId(_uuid(998)),
                provider_record_key=ProviderRecordReadKey(
                    source_name="provider-b",
                    source_record_id="shared-record",
                ),
            )
        )
        self.assertEqual(
            tuple(item.literature_id for item in one_owner.literatures),
            (other_provider_owner.literature_id,),
        )
        self.assertEqual(
            tuple(item.observation.observation_id for item in one_owner.observations),
            (other_provider_observation.observation_id,),
        )

        no_owner = reader.read_identity(
            IdentityReadRequest(
                observation_id=ObservationId(_uuid(997)),
                provider_record_key=ProviderRecordReadKey(
                    source_name="provider-c",
                    source_record_id="shared-record",
                ),
            )
        )
        self.assertEqual(no_owner, literature_ports.IdentityReadContext())

    def test_provider_record_key_fails_closed_for_dangling_observation_owner(self) -> None:
        owner = _literature(140)
        observation = _provider_observation(
            141,
            owner.metadata,
            source_name="provider-a",
            record_id="dangling-record",
        )
        self._publish_identities(
            (owner,),
            observations=(
                LiteratureObservation(
                    literature_id=owner.literature_id,
                    observation=observation,
                ),
            ),
        )
        with self.engine.write_transaction() as connection:
            connection.execute(
                "DELETE FROM literature_metadata_observations WHERE observation_id=?",
                (observation.observation_id.root,),
            )

        with self.assertRaises(LiteraturePreconditionReadError):
            self.reader.read_identity(
                IdentityReadRequest(
                    observation_id=ObservationId(_uuid(999)),
                    provider_record_key=ProviderRecordReadKey(
                        source_name="provider-a",
                        source_record_id="dangling-record",
                    ),
                )
            )

    def test_version_compound_requires_one_observation_and_stable_only_crosses_provider(
        self,
    ) -> None:
        desired_identifier = Identifier(namespace="doi", value="10.1000/compound")
        cross_provider_identifier = Identifier(namespace="arxiv", value="2608.00001")
        record_only = _literature(100)
        stable_only = _literature(101)
        cross_provider = _literature(102)
        record_observation = _provider_observation(
            110,
            _metadata(
                "Record only",
                identifiers=(Identifier(namespace="doi", value="10.1000/other"),),
            ),
            source_name="provider-a",
            record_id="shared-record",
        )
        stable_observation = _provider_observation(
            111,
            _metadata("Stable only", identifiers=(desired_identifier,)),
            source_name="provider-a",
            record_id="different-record",
        )
        cross_provider_observation = _provider_observation(
            112,
            _metadata("Cross provider", identifiers=(cross_provider_identifier,)),
            source_name="provider-b",
            record_id="provider-b-record",
        )
        self._publish_identities(
            (record_only, stable_only, cross_provider),
            observations=(
                LiteratureObservation(
                    literature_id=record_only.literature_id,
                    observation=record_observation,
                ),
                LiteratureObservation(
                    literature_id=stable_only.literature_id,
                    observation=stable_observation,
                ),
                LiteratureObservation(
                    literature_id=cross_provider.literature_id,
                    observation=cross_provider_observation,
                ),
            ),
        )
        compound = VersionLinkReadKey(
            source_name="provider-a",
            record_id="shared-record",
            stable_identifier_keys=((desired_identifier.namespace, desired_identifier.value),),
        )
        no_match = self.reader.read_identity(
            IdentityReadRequest(
                observation_id=ObservationId(_uuid(999)),
                version_link_keys=(compound,),
            )
        )
        self.assertEqual(no_match.literatures, ())
        self.assertEqual(no_match.observations, ())

        same_observation = _literature(103)
        compound_observation = _provider_observation(
            113,
            _metadata("Compound", identifiers=(desired_identifier,)),
            source_name="provider-a",
            record_id="shared-record",
        )
        self._publish_identities(
            (same_observation,),
            observations=(
                LiteratureObservation(
                    literature_id=same_observation.literature_id,
                    observation=compound_observation,
                ),
            ),
        )
        matched = self.reader.read_identity(
            IdentityReadRequest(
                observation_id=ObservationId(_uuid(999)),
                version_link_keys=(compound,),
            )
        )
        self.assertEqual(
            tuple(item.literature_id for item in matched.literatures),
            (same_observation.literature_id,),
        )
        self.assertEqual(
            tuple(item.observation.observation_id for item in matched.observations),
            (compound_observation.observation_id,),
        )

        cross_provider_match = self.reader.read_identity(
            IdentityReadRequest(
                observation_id=ObservationId(_uuid(999)),
                version_link_keys=(
                    VersionLinkReadKey(
                        source_name="provider-a",
                        stable_identifier_keys=(
                            (
                                cross_provider_identifier.namespace,
                                cross_provider_identifier.value,
                            ),
                        ),
                    ),
                ),
            )
        )
        self.assertEqual(
            tuple(item.literature_id for item in cross_provider_match.literatures),
            (cross_provider.literature_id,),
        )

    def test_public_reads_take_one_snapshot_and_return_only_scoped_closures(self) -> None:
        source_identifier = Identifier(namespace="doi", value="10.1000/source")
        source = _literature(
            200,
            meta_number=210,
            identifiers=(source_identifier,),
        )
        target = _literature(201, meta_number=210)
        unrelated = _literature(202)
        source_observation = _provider_observation(
            220,
            source.metadata,
            record_id="source-record",
            reference_texts=("Target fixture.",),
        )
        target_observation = _provider_observation(
            221,
            target.metadata,
            record_id="target-record",
        )
        unrelated_observation = _provider_observation(
            222,
            unrelated.metadata,
            record_id="unrelated-record",
        )
        self._publish_identities(
            (source, target, unrelated),
            observations=(
                LiteratureObservation(
                    literature_id=source.literature_id,
                    observation=source_observation,
                ),
                LiteratureObservation(
                    literature_id=target.literature_id,
                    observation=target_observation,
                ),
                LiteratureObservation(
                    literature_id=unrelated.literature_id,
                    observation=unrelated_observation,
                ),
            ),
        )
        provider_relation = ProviderRelationObservation(
            observation_id=ObservationId(_uuid(223)),
            provenance=_provenance(
                223,
                kind=SourceKind.METADATA_PROVIDER,
                source_name="fixture-provider",
                record_id="relation-record",
                input_sha256=sha256_digest(b"relation-record"),
            ),
            citing=ProviderLiteratureKey(record_id="source-record"),
            cited=ProviderLiteratureKey(record_id="target-record"),
        )
        self.writer.publish_provider_relation_observations((provider_relation,))
        reference = Reference(
            reference_id=ReferenceId(_uuid(224)),
            source_literature_id=source.literature_id,
            target_literature_id=target.literature_id,
        )
        provider_support = ReferenceSupport(
            reference_id=reference.reference_id,
            source=ProviderRelationSupport(
                kind="provider_relation",
                observation_id=provider_relation.observation_id,
            ),
        )
        metadata_support = ReferenceSupport(
            reference_id=reference.reference_id,
            source=MetadataReferenceTextSupport(
                kind="metadata_reference_text",
                metadata_observation_id=source_observation.observation_id,
                reference_index=0,
            ),
        )
        self.writer.publish_reference(
            ReferencePublicationCommand(
                source_token=self._token(source),
                target_token=self._token(target),
                reference=reference,
                supports=(provider_support, metadata_support),
            )
        )

        counting_engine = _CountingCatalogEngine(self.engine.catalog_path)
        reader = LiteraturePreconditionReader(counting_engine, self.verified_reader)

        identity = reader.read_identity(
            IdentityReadRequest(
                observation_id=source_observation.observation_id,
                stable_identifier_keys=((source_identifier.namespace, source_identifier.value),),
            )
        )
        self.assertEqual(counting_engine.read_snapshot_calls, 1)
        self.assertEqual(
            {item.literature_id for item in identity.literatures},
            {source.literature_id, target.literature_id},
        )
        self.assertEqual(
            {item.observation.observation_id for item in identity.observations},
            {source_observation.observation_id, target_observation.observation_id},
        )
        self.assertNotIn(
            unrelated.literature_id,
            {item.literature_id for item in identity.literatures},
        )

        content = reader.read_content(ContentReadRequest(literature_id=source.literature_id))
        self.assertEqual(counting_engine.read_snapshot_calls, 2)
        self.assertEqual(
            tuple(item.literature.literature_id for item in content.facts),
            (source.literature_id,),
        )
        self.assertEqual(content.references, (reference,))
        self.assertEqual(
            {item.model_dump_json() for item in content.supports},
            {provider_support.model_dump_json(), metadata_support.model_dump_json()},
        )
        self.assertEqual(content.reference_closure_token.reference_count, 1)
        self.assertEqual(content.reference_closure_token.support_count, 2)

        reference_context = reader.read_reference(
            ReferenceReadRequest(
                source_literature_id=source.literature_id,
                target_literature_id=target.literature_id,
                provider_relation_observation_ids=(provider_relation.observation_id,),
                metadata_reference_keys=((source_observation.observation_id, 0),),
            )
        )
        self.assertEqual(counting_engine.read_snapshot_calls, 3)
        self.assertEqual(
            {item.literature.literature_id for item in reference_context.facts},
            {source.literature_id, target.literature_id},
        )
        self.assertEqual(reference_context.references, (reference,))
        self.assertEqual(
            {item.model_dump_json() for item in reference_context.supports},
            {provider_support.model_dump_json(), metadata_support.model_dump_json()},
        )
        self.assertEqual(
            tuple(item.observation.observation_id for item in reference_context.observations),
            (source_observation.observation_id,),
        )
        self.assertEqual(reference_context.provider_relations, (provider_relation,))

        deletion = reader.read_deletion(DeletionReadRequest(literature_id=source.literature_id))
        self.assertEqual(counting_engine.read_snapshot_calls, 4)
        self.assertEqual(
            {item.literature_id for item in deletion.literatures},
            {source.literature_id, target.literature_id},
        )
        self.assertEqual(deletion.references, (reference,))
        self.assertEqual(len(deletion.meta_literatures), 1)

        current = reader.read_current_facts(
            CurrentFactsReadRequest(literature_id=source.literature_id)
        )
        self.assertEqual(counting_engine.read_snapshot_calls, 5)
        self.assertEqual(
            tuple(item.literature.literature_id for item in current.facts),
            (source.literature_id,),
        )

    def test_concurrent_commit_cannot_split_one_read_snapshot(self) -> None:
        literature = _literature(300, title="Revision one")
        self._publish_identities((literature,))
        counting_engine = _CountingCatalogEngine(self.engine.catalog_path)
        reader = LiteraturePreconditionReader(counting_engine, self.verified_reader)
        entered = threading.Event()
        release = threading.Event()
        counting_engine.pause_next_snapshot(entered, release)
        results: list[tuple[int, Sha256, str | None]] = []
        errors: list[BaseException] = []

        def read_in_thread() -> None:
            try:
                context = reader.read_current_facts(
                    CurrentFactsReadRequest(literature_id=literature.literature_id)
                )
                fact = context.facts[0]
                results.append(
                    (
                        fact.metadata_revision,
                        fact.metadata_sha256,
                        fact.literature.metadata.title,
                    )
                )
            except BaseException as error:  # pragma: no cover - asserted in parent thread.
                errors.append(error)

        worker = threading.Thread(target=read_in_thread)
        worker.start()
        self.assertTrue(entered.wait(timeout=5))
        revision_two = literature.metadata.model_copy(update={"title": "Revision two"})
        revision_two_digest = metadata_sha256(revision_two)
        with self.engine.write_transaction() as connection:
            connection.execute(
                "UPDATE literature_metadata SET metadata_revision=2,metadata_sha256=?,title=? "
                "WHERE literature_id=?",
                (
                    revision_two_digest.root,
                    revision_two.title,
                    literature.literature_id.root,
                ),
            )
        release.set()
        worker.join(timeout=5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(
            results,
            [
                (
                    1,
                    metadata_sha256(literature.metadata),
                    "Revision one",
                )
            ],
        )
        self.assertEqual(counting_engine.read_snapshot_calls, 1)

        next_context = reader.read_current_facts(
            CurrentFactsReadRequest(literature_id=literature.literature_id)
        )
        self.assertEqual(counting_engine.read_snapshot_calls, 2)
        self.assertEqual(len(next_context.facts), 1)
        self.assertEqual(next_context.facts[0].metadata_revision, 2)
        self.assertEqual(next_context.facts[0].metadata_sha256, revision_two_digest)
        self.assertEqual(next_context.facts[0].literature.metadata.title, "Revision two")

    def test_structured_content_roundtrip_checks_lineage_and_artifact_bytes(self) -> None:
        literature = _literature(30)
        self._publish_identities((literature,))
        content, structured, encoded = self._publish_complete_content(literature)

        context = self.reader.read_current_facts(
            CurrentFactsReadRequest(literature_id=literature.literature_id)
        )
        self.assertEqual(len(context.facts), 1)
        facts = context.facts[0]
        self.assertEqual(facts.current_content, content)
        self.assertEqual(facts.literature.status, LiteratureStatus.CONTENT_READY)
        self.assertEqual(len(facts.current_primary_pdfs), 1)
        self.assertIsNotNone(facts.current_parser_result)
        self.assertIsNotNone(facts.current_content_lineage)
        assert facts.current_parser_result is not None
        assert facts.current_content_lineage is not None
        self.assertEqual(
            facts.current_content_lineage.parser_result_sha256,
            facts.current_parser_result.result_sha256,
        )

        noncanonical_encoded = json.dumps(
            content.model_dump(mode="json"),
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        ).encode("utf-8")
        self.assertNotEqual(noncanonical_encoded, encoded)
        noncanonical_structured = self._publish_artifact(
            noncanonical_encoded,
            media_type="application/json",
            artifact_id="fixture-noncanonical-content",
        )
        with self.engine.write_transaction() as connection:
            connection.execute(
                "UPDATE literature_contents SET structured_artifact_path=?,"
                "structured_artifact_sha256=?,structured_artifact_byte_size=? "
                "WHERE literature_id=?",
                (
                    noncanonical_structured.path.root,
                    noncanonical_structured.sha256.root,
                    noncanonical_structured.byte_size,
                    literature.literature_id.root,
                ),
            )
        with self.assertRaises(LiteraturePreconditionReadError):
            self.reader.read_current_facts(
                CurrentFactsReadRequest(literature_id=literature.literature_id)
            )
        with self.engine.write_transaction() as connection:
            connection.execute(
                "UPDATE literature_contents SET structured_artifact_path=?,"
                "structured_artifact_sha256=?,structured_artifact_byte_size=? "
                "WHERE literature_id=?",
                (
                    structured.path.root,
                    structured.sha256.root,
                    structured.byte_size,
                    literature.literature_id.root,
                ),
            )

        wrong_input = Sha256("e" * 64)
        wrong_provenance = content.provenance.model_copy(update={"input_sha256": wrong_input})
        wrong_content = content.model_copy(update={"provenance": wrong_provenance})
        wrong_encoded = canonical_literature_content_json(wrong_content)
        wrong_structured = self._publish_artifact(
            wrong_encoded,
            media_type="application/json",
            artifact_id="fixture-wrong-lineage-content",
        )
        with self.engine.write_transaction() as connection:
            connection.execute(
                "UPDATE provenances SET input_sha256=? WHERE provenance_id=?",
                (wrong_input.root, content.provenance.provenance_id.root),
            )
            connection.execute(
                "UPDATE literature_contents SET structured_artifact_path=?,"
                "structured_artifact_sha256=?,structured_artifact_byte_size=? "
                "WHERE literature_id=?",
                (
                    wrong_structured.path.root,
                    wrong_structured.sha256.root,
                    wrong_structured.byte_size,
                    literature.literature_id.root,
                ),
            )
        with self.assertRaises(LiteraturePreconditionReadError):
            self.reader.read_current_facts(
                CurrentFactsReadRequest(literature_id=literature.literature_id)
            )

        expected_input = content.provenance.input_sha256
        self.assertIsNotNone(expected_input)
        assert expected_input is not None
        with self.engine.write_transaction() as connection:
            connection.execute(
                "UPDATE provenances SET input_sha256=? WHERE provenance_id=?",
                (expected_input.root, content.provenance.provenance_id.root),
            )
            connection.execute(
                "UPDATE literature_contents SET structured_artifact_path=?,"
                "structured_artifact_sha256=?,structured_artifact_byte_size=? "
                "WHERE literature_id=?",
                (
                    structured.path.root,
                    structured.sha256.root,
                    structured.byte_size,
                    literature.literature_id.root,
                ),
            )

        formal_path = self.storage_root.canonical_path / structured.path.root
        damaged = bytearray(encoded)
        damaged[0] = ord("[")
        formal_path.write_bytes(damaged)
        os.chmod(formal_path, 0o600)
        with self.assertRaises(LiteraturePreconditionReadError) as raised:
            self.reader.read_current_facts(
                CurrentFactsReadRequest(literature_id=literature.literature_id)
            )
        self.assertEqual(str(raised.exception), "literature precondition read failed")
        self.assertNotIn(str(self.storage_root.canonical_path), str(raised.exception))

        formal_path.write_bytes(encoded)
        os.chmod(formal_path, 0o600)
        restored = self.reader.read_current_facts(
            CurrentFactsReadRequest(literature_id=literature.literature_id)
        )
        self.assertEqual(restored.facts[0].current_content, content)
        formal_path.unlink()
        with self.assertRaises(LiteraturePreconditionReadError) as missing:
            self.reader.read_current_facts(
                CurrentFactsReadRequest(literature_id=literature.literature_id)
            )
        self.assertEqual(str(missing.exception), "literature precondition read failed")


if __name__ == "__main__":
    unittest.main()
