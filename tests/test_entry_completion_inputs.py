from __future__ import annotations

import io
import os
import unittest
from contextlib import AbstractContextManager, closing
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import BinaryIO

from sciretriever.entry.ports import ExecutionCurrentFacts
from sciretriever.literature.ports import (
    CurrentLiteratureFacts,
    IdentityObservationPublicationCommand,
    LiteratureObservation,
    metadata_sha256,
)
from sciretriever.model.acquisition import (
    Asset,
    AssetHint,
    AssetHintKind,
    AssetRole,
    LiteratureAsset,
)
from sciretriever.model.literature import Literature, LiteratureStatus, MetaLiterature, VersionRole
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
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
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.parsing.ports import ParserResultPublicationCommand, StagedParserArtifact
from sciretriever.storage.completion import (
    CompletionInputBuilder,
    CompletionInputError,
    VerifiedStorageObjectError,
    VerifiedStorageObjectRef,
)
from sciretriever.storage.files.paths import StorageRoot
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactReference, ArtifactStore
from sciretriever.storage.sqlite.artifacts import register_artifact
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.entry_reader import SqliteEntryReader
from sciretriever.storage.sqlite.literature_writer import LiteratureWriter
from sciretriever.storage.sqlite.parsing_publication import SqliteParserResultPublication

_TIME = UtcTimestamp("2026-08-12T14:00:00Z")
_PARAMETERS = Sha256("f" * 64)


def _uuid(prefix: int, number: int) -> str:
    return f"{prefix:08x}-0000-4000-8000-{number:012x}"


class _TestArtifactContent:
    """Explicit test-only path-free capability for parser publication bytes."""

    __slots__ = ("_payload",)

    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def open(self) -> AbstractContextManager[BinaryIO]:
        return closing(io.BytesIO(self._payload))

    def __repr__(self) -> str:
        return "<_TestArtifactContent>"


class _PathWrapper:
    __slots__ = ("path",)

    def __init__(self, path: Path) -> None:
        self.path = path

    def open(self) -> AbstractContextManager[BinaryIO]:
        return self.path.open("rb")


class CompletionInputBuilderTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = TemporaryDirectory(prefix="sciretriever-completion-inputs-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        os.chmod(self.base, 0o700)
        self.engine = CatalogEngine(self.base / "catalog.sqlite")
        self.root = StorageRoot(self.base / "artifacts")
        self.store = ArtifactStore(self.root, max_artifact_bytes=4096)
        self.verified_reader = VerifiedReader(self.root, max_artifact_bytes=4096)
        self.writer = LiteratureWriter(self.engine)
        self.reader = SqliteEntryReader(self.engine, self.verified_reader)
        self.parser_publication = SqliteParserResultPublication(
            self.engine,
            self.store,
            self.verified_reader,
        )
        self.builder = CompletionInputBuilder(self.engine, self.verified_reader)
        self.literature = Literature(
            literature_id=LiteratureId(_uuid(1, 1)),
            meta_literature_id=MetaLiteratureId(_uuid(2, 1)),
            version_role=VersionRole.PUBLISHED,
            metadata=LiteratureMetadata(
                title="Completion input integration",
                publisher="Example Publisher",
            ),
            status=LiteratureStatus.UNREVIEWED,
        )
        self.user_observation = MetadataObservation(
            observation_id=ObservationId(_uuid(3, 1)),
            provenance=Provenance(
                provenance_id=ProvenanceId(_uuid(4, 1)),
                source_kind=SourceKind.USER,
                source_name="bibliographic-import",
                source_record_id=None,
                observed_at=_TIME,
                input_sha256=None,
                parameters_sha256=None,
            ),
            metadata=self.literature.metadata,
        )
        self.provider_observation = MetadataObservation(
            observation_id=ObservationId(_uuid(3, 2)),
            provenance=Provenance(
                provenance_id=ProvenanceId(_uuid(4, 2)),
                source_kind=SourceKind.METADATA_PROVIDER,
                source_name="completion-provider",
                source_record_id="provider-record",
                observed_at=_TIME,
                input_sha256=sha256_digest(b"provider-response"),
                parameters_sha256=None,
            ),
            metadata=self.literature.metadata,
            reference_texts=("A provider reference retained in the closure.",),
            asset_hints=(
                AssetHint(
                    url="https://content.example.test/paper.pdf",
                    kind=AssetHintKind.DIRECT_FILE,
                    media_type="application/pdf",
                    asset_role=AssetRole.PRIMARY_PDF,
                ),
            ),
        )
        self.writer.publish_identity_and_observation(
            IdentityObservationPublicationCommand(
                literatures=(self.literature,),
                meta_literatures=(
                    MetaLiterature(
                        meta_literature_id=self.literature.meta_literature_id,
                        representative_literature_id=self.literature.literature_id,
                    ),
                ),
                observations=(
                    LiteratureObservation(
                        literature_id=self.literature.literature_id,
                        observation=self.provider_observation,
                    ),
                    LiteratureObservation(
                        literature_id=self.literature.literature_id,
                        observation=self.user_observation,
                    ),
                ),
                facts=(
                    CurrentLiteratureFacts(
                        literature=self.literature,
                        metadata_revision=1,
                        metadata_sha256=metadata_sha256(self.literature.metadata),
                    ),
                ),
                expected_tokens=(),
                expected_meta_tokens=(),
            )
        )

    def _current(self) -> ExecutionCurrentFacts:
        snapshot = self.reader.read_current(self.literature.literature_id)
        self.assertEqual(len(snapshot.current_facts), 1)
        return snapshot.current_facts[0]

    def _publish_registered(
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

    def _publish_primary(self) -> tuple[Asset, LiteratureAsset, bytes]:
        payload = b"%PDF-1.7\ncompletion input fixture\n"
        reference = self._publish_registered(payload, "application/pdf", "completion-pdf")
        asset = Asset(
            asset_id=AssetId(_uuid(5, 1)),
            sha256=reference.sha256,
            size_bytes=reference.byte_size,
            media_type=reference.media_type,
            path=reference.path,
        )
        relation = LiteratureAsset(
            literature_asset_id=LiteratureAssetId(_uuid(6, 1)),
            literature_id=self.literature.literature_id,
            asset_id=asset.asset_id,
            role=AssetRole.PRIMARY_PDF,
            provenance=Provenance(
                provenance_id=ProvenanceId(_uuid(7, 1)),
                source_kind=SourceKind.ASSET_PROVIDER,
                source_name="completion-asset-provider",
                source_record_id="asset-record",
                observed_at=_TIME,
                input_sha256=asset.sha256,
                parameters_sha256=None,
            ),
            source_url="https://content.example.test/paper.pdf",
        )
        self.writer.publish_asset(asset)
        self.writer.publish_literature_asset(relation)
        return asset, relation, payload

    def _publish_parser(self, asset: Asset) -> ParserResult:
        payload = b"# Parsed completion input\n\nBody.\n"
        artifact = ParserArtifactRef(
            sha256=sha256_digest(payload),
            media_type="text/markdown",
            byte_size=len(payload),
        )
        provenance = ParserProvenance(
            provenance=Provenance(
                provenance_id=ProvenanceId(_uuid(8, 1)),
                source_kind=SourceKind.PARSER,
                source_name="completion-parser",
                source_record_id=None,
                observed_at=_TIME,
                input_sha256=asset.sha256,
                parameters_sha256=_PARAMETERS,
            ),
            parser_version="1.0",
        )
        result = ParserResult(
            source_asset_id=asset.asset_id,
            source_sha256=asset.sha256,
            result_sha256=parser_result_sha256(
                source_asset_id=asset.asset_id,
                source_sha256=asset.sha256,
                page_count=1,
                markdown=artifact,
                resources=(),
                provenance=provenance,
            ),
            page_count=1,
            markdown=artifact,
            resources=(),
            provenance=provenance,
        )
        self.parser_publication.publish_current(
            ParserResultPublicationCommand(
                result=result,
                markdown=StagedParserArtifact(
                    artifact=artifact,
                    content=_TestArtifactContent(payload),
                ),
                resources=(),
            )
        )
        return result

    def test_acquisition_request_uses_exact_current_closure_without_guesses(self) -> None:
        current = self._current()

        request = self.builder.build_acquisition_request(
            current,
            excluded_candidate_keys=frozenset({"run-local-candidate"}),
        )

        self.assertEqual(
            request.observations,
            (self.user_observation, self.provider_observation),
        )
        self.assertEqual(request.current_assets, ())
        self.assertEqual(request.excluded_candidate_keys, frozenset({"run-local-candidate"}))
        self.assertIsNone(request.resolved_landing_origin)
        self.assertEqual(request.observations[1].asset_hints, self.provider_observation.asset_hints)
        self.assertEqual(
            request.observations[1].reference_texts,
            self.provider_observation.reference_texts,
        )

    def test_parser_and_analysis_inputs_bind_the_exact_current_facts(self) -> None:
        asset, relation, payload = self._publish_primary()
        current = self._current()

        parser_request = self.builder.build_parser_request(current)

        self.assertEqual(parser_request.source_asset_id, asset.asset_id)
        self.assertEqual(parser_request.source_sha256, asset.sha256)
        self.assertIsInstance(parser_request.content_ref, VerifiedStorageObjectRef)
        self.assertNotIn(str(self.base), repr(parser_request.content_ref))
        self.assertNotIn(asset.path.root, repr(parser_request.content_ref))
        with parser_request.content_ref.open() as stream:
            self.assertEqual(stream.read(), payload)

        parser_result = self._publish_parser(asset)
        refreshed = self._current()
        analysis_input = self.builder.build_content_analysis_input(refreshed)

        self.assertEqual(analysis_input.primary_asset_id, asset.asset_id)
        self.assertEqual(analysis_input.primary_pdf_sha256, asset.sha256)
        self.assertEqual(analysis_input.parser_result, parser_result)
        self.assertEqual(analysis_input.initial_metadata, self.literature.metadata)
        self.assertEqual(analysis_input.input_metadata_revision, 1)
        self.assertEqual(
            analysis_input.input_metadata_sha256,
            metadata_sha256(self.literature.metadata),
        )
        self.assertEqual(analysis_input.user_observations, (self.user_observation,))
        acquisition_with_primary = self.builder.build_acquisition_request(
            refreshed,
            excluded_candidate_keys=frozenset(),
        )
        self.assertEqual(acquisition_with_primary.current_assets, (relation,))

    def test_sealed_capability_rejects_tamper_and_inode_replacement_without_path_leaks(
        self,
    ) -> None:
        asset, _relation, payload = self._publish_primary()
        request = self.builder.build_parser_request(self._current())
        capability = request.content_ref
        target = self.root.canonical_path / asset.path.root

        target.write_bytes(b"tampered completion bytes")
        os.chmod(target, 0o600)
        with self.assertRaises(VerifiedStorageObjectError) as tampered:
            with capability.open():
                self.fail("tampered bytes returned a stream")
        self.assertNotIn(str(self.base), f"{tampered.exception!s} {tampered.exception!r}")

        target.write_bytes(payload)
        os.chmod(target, 0o600)
        replacement = self.base / "replacement-pdf"
        replacement.write_bytes(payload)
        os.chmod(replacement, 0o600)
        target.unlink()
        replacement.rename(target)
        with self.assertRaises(VerifiedStorageObjectError) as replaced:
            with capability.open():
                self.fail("a replacement inode returned a stream")
        rendered = f"{replaced.exception!s} {replaced.exception!r} {capability!r}"
        self.assertNotIn(str(self.base), rendered)
        self.assertNotIn(asset.path.root, rendered)

    def test_sealed_capability_cannot_be_created_from_paths_or_path_wrappers(self) -> None:
        absolute = self.base / "private.pdf"
        for value in (absolute, _PathWrapper(absolute)):
            with self.subTest(value=type(value).__name__):
                with self.assertRaises(TypeError) as raised:
                    VerifiedStorageObjectRef(value)
                self.assertNotIn(str(absolute), str(raised.exception))

    def test_builders_reject_incomplete_or_misaligned_current_facts(self) -> None:
        current = self._current()
        without_observations = ExecutionCurrentFacts(current=current.current)
        with self.assertRaises(CompletionInputError):
            self.builder.build_acquisition_request(
                without_observations,
                excluded_candidate_keys=frozenset(),
            )

        asset, _relation, _payload = self._publish_primary()
        parser = self._publish_parser(asset)
        refreshed = self._current()
        wrong_parser = parser.model_copy(update={"source_sha256": Sha256("a" * 64)})
        misaligned = ExecutionCurrentFacts(
            current=refreshed.current.model_copy(update={"current_parser_result": wrong_parser}),
            metadata_observations=refreshed.metadata_observations,
        )
        with self.assertRaises(CompletionInputError):
            self.builder.build_content_analysis_input(misaligned)


if __name__ == "__main__":
    unittest.main()
