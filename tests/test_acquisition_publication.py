from __future__ import annotations

import io
import os
import unittest
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import BinaryIO
from unittest import mock

from PyPDF2 import PdfWriter

import sciretriever.acquisition.ports as acquisition_ports
import sciretriever.acquisition.publication as acquisition_publication
from sciretriever.acquisition.ports import (
    AcquisitionExhaustionPublicationCommand,
    AcquisitionExpectedFacts,
    AcquisitionFailure,
    TemporaryPdf,
    ValidatedPdfContent,
    ValidatedPrimaryPdfPublicationCommand,
)
from sciretriever.acquisition.publication import (
    PrimaryPdfPublisher,
    ValidatedPrimaryPdfPublisher,
)
from sciretriever.acquisition.routing import AcquisitionRequest
from sciretriever.acquisition.rules import (
    PdfValidationCancelled,
    PdfValidationCode,
    PdfValidationError,
    PdfValidationStagingError,
    validate_pdf,
)
from sciretriever.literature.content import metadata_sha256
from sciretriever.literature.ports import (
    IdentityObservationPublicationCommand,
    LiteratureIdentityToken,
    LiteratureObservation,
)
from sciretriever.literature.state import CurrentLiteratureFacts
from sciretriever.model.acquisition import (
    AcquiredPrimaryPdf,
    AcquisitionPath,
    AssetRole,
    AutomaticPdfAcquisitionExhaustion,
    PdfCandidate,
)
from sciretriever.model.literature import (
    Identifier,
    Literature,
    LiteratureStatus,
    MetaLiterature,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
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
from sciretriever.storage.files.paths import StorageRoot, content_addressed_reference
from sciretriever.storage.files.reader import VerifiedReader, VerifiedReaderError
from sciretriever.storage.files.store import ArtifactStore, ArtifactStoreError
from sciretriever.storage.pdf_validation_staging import SystemPdfValidationStaging
from sciretriever.storage.sqlite.acquisition_publication import (
    AcquisitionPublicationError,
    SqliteAcquisitionPublication,
)
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.literature_writer import LiteratureWriter

_TIMESTAMP = UtcTimestamp("2026-08-11T08:00:00Z")


def _uuid(index: int) -> str:
    return f"{index:08x}-0000-4000-8000-{index:012x}"


def _pdf_bytes(*, width: int = 72) -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=width, height=72)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def _metadata(index: int) -> LiteratureMetadata:
    return LiteratureMetadata(
        title=f"Publication fixture {index}",
        publication_year=2026,
        identifiers=(Identifier(namespace="doi", value=f"10.1000/publication-{index}"),),
        keywords=("publication",),
    )


def _literature(index: int) -> Literature:
    return Literature(
        literature_id=LiteratureId(_uuid(100 + index)),
        meta_literature_id=MetaLiteratureId(_uuid(200 + index)),
        version_role=VersionRole.OTHER,
        metadata=_metadata(index),
        status=LiteratureStatus.UNREVIEWED,
    )


def _metadata_provenance(index: int) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(_uuid(300 + index)),
        source_kind=SourceKind.METADATA_PROVIDER,
        source_name="fixture-metadata",
        source_record_id=f"record-{index}",
        observed_at=_TIMESTAMP,
        input_sha256=Sha256(f"{index % 16:x}" * 64),
        parameters_sha256=None,
    )


def _observation(index: int, literature: Literature) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_uuid(400 + index)),
        provenance=_metadata_provenance(index),
        metadata=literature.metadata,
    )


def _asset_provenance(
    index: int,
    *,
    source_name: str = "fixture-source",
    input_sha256: Sha256 | None = None,
) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(_uuid(500 + index)),
        source_kind=SourceKind.ASSET_PROVIDER,
        source_name=source_name,
        source_record_id=f"asset-record-{index}",
        observed_at=_TIMESTAMP,
        input_sha256=input_sha256,
        parameters_sha256=None,
    )


def _manual_provenance(index: int) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(_uuid(600 + index)),
        source_kind=SourceKind.USER,
        source_name="manual-pdf",
        source_record_id=None,
        observed_at=_TIMESTAMP,
        input_sha256=None,
        parameters_sha256=None,
    )


class _TemporaryContent:
    def __init__(self, source: bytes | BinaryIO | BaseException) -> None:
        self.source = source
        self.open_calls = 0
        self.discard_calls = 0
        self.discarded = False

    @contextmanager
    def open(self) -> Iterator[BinaryIO]:
        self.open_calls += 1
        source = self.source
        if isinstance(source, BaseException):
            raise source
        if isinstance(source, bytes):
            stream = io.BytesIO(source)
            try:
                yield stream
            finally:
                stream.close()
            return
        yield source

    def discard(self) -> None:
        self.discard_calls += 1
        self.discarded = True


class _ExplodingReader(io.BytesIO):
    def read(self, size: int | None = -1, /) -> bytes:
        del size
        raise OSError("private source failure must not escape")


class _ValidatedContentSpy:
    def __init__(self, content: ValidatedPdfContent) -> None:
        self._content = content
        self.open_calls = 0

    @property
    def sha256(self) -> Sha256:
        return self._content.sha256

    @property
    def byte_size(self) -> int:
        return self._content.byte_size

    @property
    def media_type(self) -> str:
        return self._content.media_type

    def open(self) -> AbstractContextManager[BinaryIO]:
        self.open_calls += 1
        return self._content.open()


class _Environment:
    def __init__(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-a3-tests-")
        base = Path(self.temporary.name)
        self.root = StorageRoot(base / "artifacts")
        self.engine = CatalogEngine(base / "catalog.sqlite")
        self.store = ArtifactStore(self.root)
        self.reader = VerifiedReader(self.root)
        self.pdf_validation_staging = SystemPdfValidationStaging(parent=base)
        self.writer = LiteratureWriter(self.engine)
        self.literatures = tuple(_literature(index) for index in range(1, 4))
        self.observations = tuple(
            _observation(index, literature)
            for index, literature in enumerate(self.literatures, start=1)
        )
        self._publish_initial_facts()

    def cleanup(self) -> None:
        self.temporary.cleanup()

    def _publish_initial_facts(self) -> None:
        self.writer.publish_identity_and_observation(
            IdentityObservationPublicationCommand(
                literatures=self.literatures,
                meta_literatures=tuple(
                    MetaLiterature(
                        meta_literature_id=literature.meta_literature_id,
                        representative_literature_id=literature.literature_id,
                    )
                    for literature in self.literatures
                ),
                observations=tuple(
                    LiteratureObservation(
                        literature_id=literature.literature_id,
                        observation=observation,
                    )
                    for literature, observation in zip(
                        self.literatures,
                        self.observations,
                        strict=True,
                    )
                ),
                facts=tuple(
                    CurrentLiteratureFacts(
                        literature=literature,
                        metadata_revision=1,
                        metadata_sha256=metadata_sha256(literature.metadata),
                    )
                    for literature in self.literatures
                ),
                expected_tokens=(),
                expected_meta_tokens=(),
            )
        )


def _expected(
    literature: Literature,
    *,
    meta_literature_id: MetaLiteratureId | None = None,
    metadata_revision: int = 1,
    metadata_digest: Sha256 | None = None,
) -> AcquisitionExpectedFacts:
    return AcquisitionExpectedFacts(
        literature_id=literature.literature_id,
        meta_literature_id=meta_literature_id or literature.meta_literature_id,
        metadata_revision=metadata_revision,
        metadata_sha256=metadata_digest or metadata_sha256(literature.metadata),
        expected_no_primary_pdf=True,
    )


def _request(
    environment: _Environment,
    index: int,
    *,
    literature: Literature | None = None,
    expected_facts: AcquisitionExpectedFacts | None = None,
) -> AcquisitionRequest:
    selected = literature or environment.literatures[index]
    observations = (
        (environment.observations[index],)
        if selected.literature_id == environment.literatures[index].literature_id
        else ()
    )
    return AcquisitionRequest(
        literature=selected,
        expected_facts=expected_facts or _expected(selected),
        observations=observations,
    )


def _temporary_pdf(
    payload: bytes | BinaryIO | BaseException,
    *,
    index: int,
    candidate_key: str | None = None,
    provenance: Provenance | None = None,
    source_url: str | None = "https://provider.test/articles/file.pdf",
) -> tuple[TemporaryPdf, _TemporaryContent]:
    content = _TemporaryContent(payload)
    candidate = PdfCandidate(
        candidate_key=candidate_key or f"candidate-{index}",
        source_name="fixture-source",
        acquisition_path=AcquisitionPath.PUBLIC,
        declared_media_type="text/html",
    )
    return (
        TemporaryPdf(
            candidate=candidate,
            content=content,
            safe_source_url=source_url,
            provenance=provenance or _asset_provenance(index),
        ),
        content,
    )


def _fail_at(expected: str) -> Callable[[str], None]:
    def failpoint(name: str) -> None:
        if name == expected:
            raise RuntimeError("injected failpoint")

    return failpoint


def _prepare_and_commit(
    publisher: PrimaryPdfPublisher,
    request: AcquisitionRequest,
    temporary: TemporaryPdf,
) -> AcquiredPrimaryPdf | None:
    try:
        prepared = publisher.prepare_primary_pdf(request, temporary)
    finally:
        temporary.content.discard()
    if prepared is None:
        return None
    return publisher.commit_primary_pdf(prepared)


class AcquisitionPublicationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = self._new_environment()

    def _new_environment(self) -> _Environment:
        environment = _Environment()
        self.addCleanup(environment.cleanup)
        return environment

    def _adapter(
        self,
        environment: _Environment | None = None,
        *,
        failpoint: Callable[[str], None] | None = None,
    ) -> SqliteAcquisitionPublication:
        selected = environment or self.environment
        return SqliteAcquisitionPublication(
            selected.engine,
            selected.store,
            selected.reader,
            failpoint=failpoint,
        )

    def _validated_publisher(
        self,
        *,
        environment: _Environment | None = None,
        adapter: SqliteAcquisitionPublication | None = None,
        id_index: int = 1,
    ) -> ValidatedPrimaryPdfPublisher:
        selected_adapter = adapter or self._adapter(environment)
        return ValidatedPrimaryPdfPublisher(
            selected_adapter,
            artifact_id_factory=lambda: f"acquisition-artifact-{id_index}",
            asset_id_factory=lambda: AssetId(_uuid(700 + id_index)),
            literature_asset_id_factory=lambda: LiteratureAssetId(_uuid(800 + id_index)),
        )

    def _publisher(
        self,
        *,
        environment: _Environment | None = None,
        adapter: SqliteAcquisitionPublication | None = None,
        id_index: int = 1,
    ) -> PrimaryPdfPublisher:
        return PrimaryPdfPublisher(
            self._validated_publisher(
                environment=environment,
                adapter=adapter,
                id_index=id_index,
            ),
            staging=(environment or self.environment).pdf_validation_staging,
        )

    def _publish(
        self,
        *,
        environment: _Environment | None = None,
        literature_index: int = 0,
        id_index: int = 1,
        payload: bytes | None = None,
        provenance: Provenance | None = None,
        source_url: str | None = "https://provider.test/articles/file.pdf",
        candidate_key: str | None = None,
        adapter: SqliteAcquisitionPublication | None = None,
        request: AcquisitionRequest | None = None,
    ) -> tuple[AcquiredPrimaryPdf, _TemporaryContent]:
        selected = environment or self.environment
        temporary, content = _temporary_pdf(
            payload or _pdf_bytes(),
            index=id_index,
            candidate_key=candidate_key,
            provenance=provenance,
            source_url=source_url,
        )
        selected_request = request or _request(selected, literature_index)
        publisher = self._publisher(
            environment=selected,
            adapter=adapter,
            id_index=id_index,
        )
        try:
            prepared = publisher.prepare_primary_pdf(selected_request, temporary)
        finally:
            temporary.content.discard()
        self.assertIsNotNone(prepared)
        assert prepared is not None
        result = publisher.commit_primary_pdf(prepared)
        self.assertIsInstance(result, AcquiredPrimaryPdf)
        assert isinstance(result, AcquiredPrimaryPdf)
        return result, content

    def _table_rows(self, environment: _Environment, table: str) -> tuple[tuple[object, ...], ...]:
        with environment.engine.read_snapshot() as connection:
            return tuple(tuple(row) for row in connection.execute(f'SELECT * FROM "{table}"'))

    def _acquisition_snapshot(
        self, environment: _Environment
    ) -> dict[str, tuple[tuple[object, ...], ...]]:
        return {
            table: self._table_rows(environment, table)
            for table in (
                "artifact_objects",
                "assets",
                "literature_assets",
                "provenances",
                "automatic_pdf_acquisition_exhaustions",
            )
        }

    def _insert_exhaustion(self, environment: _Environment, index: int) -> None:
        with environment.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO automatic_pdf_acquisition_exhaustions(literature_id) VALUES(?)",
                (environment.literatures[index].literature_id.root,),
            )

    def test_commit_port_contracts_have_one_authoritative_module(self) -> None:
        moved_contracts = (
            "PrimaryPdfPublicationResult",
            "ValidatedPrimaryPdfCommitPort",
            "ValidatedPrimaryPdfPublicationCommand",
        )
        for name in moved_contracts:
            with self.subTest(name=name):
                self.assertTrue(hasattr(acquisition_ports, name))
                self.assertFalse(hasattr(acquisition_publication, name))

    def test_valid_pdf_publishes_file_asset_relation_and_clears_exhaustion_atomically(self) -> None:
        environment = self.environment
        self._insert_exhaustion(environment, 0)
        payload = _pdf_bytes()
        result, content = self._publish(
            payload=payload,
            candidate_key="runtime-only-candidate",
        )

        self.assertEqual(result.candidate_key, "runtime-only-candidate")
        self.assertEqual(result.asset.sha256, sha256_digest(payload))
        self.assertEqual(result.asset.size_bytes, len(payload))
        self.assertEqual(result.asset.media_type, "application/pdf")
        self.assertIs(result.relation.role, AssetRole.PRIMARY_PDF)
        self.assertEqual(result.relation.literature_id, environment.literatures[0].literature_id)
        self.assertEqual(result.relation.provenance.input_sha256, result.asset.sha256)
        self.assertEqual(content.open_calls, 1)
        self.assertEqual(content.discard_calls, 1)
        self.assertTrue(content.discarded)
        with environment.engine.read_snapshot() as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM assets").fetchone(), (1,))
            self.assertEqual(
                connection.execute("SELECT count(*) FROM literature_assets").fetchone(),
                (1,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM automatic_pdf_acquisition_exhaustions"
                ).fetchone(),
                (0,),
            )
        with environment.reader.open(
            result.asset.path,
            sha256=result.asset.sha256,
            byte_size=result.asset.size_bytes,
            media_type=result.asset.media_type,
        ) as stream:
            self.assertEqual(stream.read(), payload)

    def test_candidate_neutral_validated_primitive_supports_manual_provenance_without_candidate(
        self,
    ) -> None:
        payload = _pdf_bytes(width=73)
        validated = validate_pdf(
            io.BytesIO(payload),
            staging=self.environment.pdf_validation_staging,
            candidate_belongs_to_literature=True,
            max_bytes=len(payload),
        )
        published = self._validated_publisher(id_index=2).publish_validated_primary_pdf(
            expected_facts=_expected(self.environment.literatures[0]),
            validated_pdf=validated,
            provenance=_manual_provenance(2),
            source_url=None,
        )

        self.assertTrue(validated.closed)
        self.assertEqual(published.asset.sha256, sha256_digest(payload))
        self.assertIsNone(published.relation.source_url)
        self.assertIs(published.relation.provenance.source_kind, SourceKind.USER)
        self.assertEqual(published.relation.provenance.source_name, "manual-pdf")
        self.assertEqual(published.relation.provenance.input_sha256, published.asset.sha256)
        self.assertEqual(
            published.relation.literature_id,
            self.environment.literatures[0].literature_id,
        )

    def test_storage_commit_consumes_the_validated_content_port_exactly_once(self) -> None:
        payload = _pdf_bytes(width=74)
        digest = sha256_digest(payload)
        validated = validate_pdf(
            io.BytesIO(payload),
            staging=self.environment.pdf_validation_staging,
            candidate_belongs_to_literature=True,
            max_bytes=len(payload),
        )
        self.addCleanup(validated.close)
        content = _ValidatedContentSpy(validated)
        command = ValidatedPrimaryPdfPublicationCommand(
            expected_facts=_expected(self.environment.literatures[0]),
            proposed_artifact_id="acquisition-artifact-content-port",
            proposed_asset_id=AssetId(_uuid(704)),
            proposed_literature_asset_id=LiteratureAssetId(_uuid(804)),
            provenance=_asset_provenance(4, input_sha256=digest),
            source_url="https://provider.test/articles/content-port.pdf",
        )

        result = self._adapter().commit_validated_primary_pdf(command, content)

        self.assertEqual(content.open_calls, 1)
        self.assertEqual(result.asset.sha256, digest)
        self.assertEqual(result.asset.size_bytes, len(payload))
        self.assertEqual(result.relation.provenance, command.provenance)

    def test_exact_replay_and_new_proposed_ids_return_database_actual_ids(self) -> None:
        payload = _pdf_bytes()
        provenance = _asset_provenance(10)
        first, _ = self._publish(payload=payload, provenance=provenance, id_index=10)
        replay, _ = self._publish(payload=payload, provenance=provenance, id_index=10)
        new_proposals, _ = self._publish(payload=payload, provenance=provenance, id_index=11)

        self.assertEqual(replay.asset.asset_id, first.asset.asset_id)
        self.assertEqual(replay.relation.literature_asset_id, first.relation.literature_asset_id)
        self.assertEqual(new_proposals.asset.asset_id, first.asset.asset_id)
        self.assertEqual(
            new_proposals.relation.literature_asset_id,
            first.relation.literature_asset_id,
        )
        self.assertNotEqual(first.asset.asset_id, AssetId(_uuid(711)))
        self.assertNotEqual(first.relation.literature_asset_id, LiteratureAssetId(_uuid(811)))
        with self.environment.engine.read_snapshot() as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM assets").fetchone(), (1,))
            self.assertEqual(
                connection.execute("SELECT count(*) FROM literature_assets").fetchone(),
                (1,),
            )

    def test_same_bytes_are_one_asset_across_literatures_with_distinct_relations(self) -> None:
        payload = _pdf_bytes()
        provenance = _asset_provenance(12)
        first, _ = self._publish(payload=payload, provenance=provenance, id_index=12)
        second, _ = self._publish(
            literature_index=1,
            payload=payload,
            provenance=provenance,
            id_index=13,
        )

        self.assertEqual(second.asset.asset_id, first.asset.asset_id)
        self.assertNotEqual(
            second.relation.literature_asset_id,
            first.relation.literature_asset_id,
        )
        self.assertNotEqual(second.relation.literature_id, first.relation.literature_id)
        with self.environment.engine.read_snapshot() as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM assets").fetchone(), (1,))
            self.assertEqual(
                connection.execute("SELECT count(*) FROM literature_assets").fetchone(),
                (2,),
            )

    def test_asset_and_relation_proposed_id_conflicts_fail_closed_without_overwrite(self) -> None:
        first_payload = _pdf_bytes(width=72)
        second_payload = _pdf_bytes(width=75)
        first, _ = self._publish(payload=first_payload, id_index=20)
        before = self._acquisition_snapshot(self.environment)

        with self.assertRaises(AcquisitionFailure):
            self._publish(
                literature_index=1,
                payload=second_payload,
                id_index=20,
                provenance=_asset_provenance(21),
            )
        self.assertEqual(self._acquisition_snapshot(self.environment), before)
        with self.environment.reader.open(
            first.asset.path,
            sha256=first.asset.sha256,
            byte_size=first.asset.size_bytes,
            media_type=first.asset.media_type,
        ) as stream:
            self.assertEqual(stream.read(), first_payload)

        conflicting_relation_publisher = PrimaryPdfPublisher(
            ValidatedPrimaryPdfPublisher(
                self._adapter(),
                artifact_id_factory=lambda: "acquisition-artifact-22",
                asset_id_factory=lambda: AssetId(_uuid(722)),
                literature_asset_id_factory=lambda: LiteratureAssetId(_uuid(820)),
            ),
            staging=self.environment.pdf_validation_staging,
        )
        temporary, _ = _temporary_pdf(
            first_payload,
            index=22,
            provenance=_asset_provenance(20),
        )
        request = _request(self.environment, 1)
        with self.assertRaises(AcquisitionFailure):
            _prepare_and_commit(conflicting_relation_publisher, request, temporary)

    def test_existing_different_primary_and_same_hash_different_relation_semantics_are_rejected(
        self,
    ) -> None:
        payload = _pdf_bytes()
        first_provenance = _asset_provenance(30)
        first, _ = self._publish(
            payload=payload,
            id_index=30,
            provenance=first_provenance,
            source_url="https://provider.test/first.pdf",
        )
        before = self._acquisition_snapshot(self.environment)

        cases = (
            (
                _pdf_bytes(width=76),
                _asset_provenance(31),
                "https://provider.test/second.pdf",
            ),
            (payload, _asset_provenance(32), "https://provider.test/first.pdf"),
            (payload, first_provenance, "https://provider.test/different.pdf"),
        )
        for index, (candidate, provenance, source_url) in enumerate(cases, start=31):
            with self.subTest(index=index):
                temporary, _ = _temporary_pdf(
                    candidate,
                    index=index,
                    provenance=provenance,
                    source_url=source_url,
                )
                request = _request(self.environment, 0)
                with self.assertRaises(AcquisitionFailure):
                    _prepare_and_commit(self._publisher(id_index=index), request, temporary)
                self.assertEqual(self._acquisition_snapshot(self.environment), before)
        self.assertEqual(first.asset.sha256, sha256_digest(payload))

    def test_preexisting_wrong_formal_target_is_preserved_and_never_catalogued(self) -> None:
        payload = _pdf_bytes(width=78)
        digest = sha256_digest(payload)
        reference = content_addressed_reference(digest, len(payload))
        formal = self.environment.root.canonical_path / reference.root
        formal.parent.mkdir(mode=0o700, parents=True)
        wrong = b"wrong formal bytes"
        formal.write_bytes(wrong)
        os.chmod(formal, 0o600)

        temporary, _ = _temporary_pdf(payload, index=40)
        request = _request(self.environment, 0)
        with self.assertRaises(AcquisitionFailure):
            _prepare_and_commit(self._publisher(id_index=40), request, temporary)
        self.assertEqual(formal.read_bytes(), wrong)
        self.assertEqual(self._table_rows(self.environment, "artifact_objects"), ())
        self.assertEqual(self._table_rows(self.environment, "assets"), ())
        self.assertEqual(self._table_rows(self.environment, "literature_assets"), ())

    def test_literature_meta_revision_hash_and_deleted_targets_are_cas_failures(self) -> None:
        literature = self.environment.literatures[0]
        cases = (
            literature.model_copy(
                update={"meta_literature_id": self.environment.literatures[1].meta_literature_id}
            ),
            literature,
            literature,
            _literature(99),
        )
        expected = (
            _expected(
                cases[0],
                meta_literature_id=cases[0].meta_literature_id,
            ),
            _expected(literature, metadata_revision=2),
            _expected(literature, metadata_digest=Sha256("f" * 64)),
            _expected(cases[3]),
        )
        for index, (target, facts) in enumerate(zip(cases, expected, strict=True), start=50):
            with self.subTest(index=index):
                request = AcquisitionRequest(literature=target, expected_facts=facts)
                temporary, _ = _temporary_pdf(_pdf_bytes(width=index), index=index)
                with self.assertRaises(AcquisitionFailure):
                    _prepare_and_commit(self._publisher(id_index=index), request, temporary)
                self.assertEqual(self._table_rows(self.environment, "assets"), ())
                self.assertEqual(self._table_rows(self.environment, "literature_assets"), ())

    def test_aligned_content_rejects_publication_even_when_primary_relation_is_absent(self) -> None:
        result, _ = self._publish(id_index=60)
        self._insert_aligned_content_and_remove_relation(result)
        before = self._acquisition_snapshot(self.environment)
        temporary, _ = _temporary_pdf(_pdf_bytes(width=79), index=61)
        request = _request(self.environment, 0)
        with self.assertRaises(AcquisitionFailure):
            _prepare_and_commit(self._publisher(id_index=61), request, temporary)
        self.assertEqual(self._acquisition_snapshot(self.environment), before)

    def _insert_aligned_content_and_remove_relation(self, result: AcquiredPrimaryPdf) -> None:
        hashes = tuple(Sha256(character * 64) for character in ("a", "b", "c", "d"))
        parser_markdown, structured, markdown, parser_result = hashes
        paths = (
            content_addressed_reference(parser_markdown, 3).root,
            content_addressed_reference(structured, 4).root,
            content_addressed_reference(markdown, 5).root,
        )
        parser_provenance = _asset_provenance(63).model_copy(
            update={"source_kind": SourceKind.PARSER, "source_name": "fixture-parser"}
        )
        analysis_provenance = _asset_provenance(64).model_copy(
            update={"source_kind": SourceKind.ANALYSIS, "source_name": "fixture-analysis"}
        )
        literature = self.environment.literatures[0]
        with self.environment.engine.write_transaction() as connection:
            connection.executemany(
                "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,"
                "relative_path) VALUES(?,?,?,?,?)",
                (
                    ("aligned-parser-markdown", parser_markdown.root, 3, "text/markdown", paths[0]),
                    ("aligned-structured", structured.root, 4, "application/json", paths[1]),
                    ("aligned-markdown", markdown.root, 5, "text/markdown", paths[2]),
                ),
            )
            for provenance in (parser_provenance, analysis_provenance):
                connection.execute(
                    "INSERT INTO provenances("
                    "provenance_id,source_kind,source_name,source_record_id,"
                    "observed_at,input_sha256,parameters_sha256) VALUES(?,?,?,?,?,?,?)",
                    (
                        provenance.provenance_id.root,
                        provenance.source_kind.value,
                        provenance.source_name,
                        provenance.source_record_id,
                        provenance.observed_at.root,
                        None if provenance.input_sha256 is None else provenance.input_sha256.root,
                        None,
                    ),
                )
            connection.execute(
                "INSERT INTO parser_results(source_asset_id,source_sha256,result_sha256,page_count,"
                "markdown_artifact_path,markdown_sha256,markdown_byte_size,markdown_media_type,"
                "provenance_id,parser_version,mode,model_identity) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    result.asset.asset_id.root,
                    result.asset.sha256.root,
                    parser_result.root,
                    1,
                    paths[0],
                    parser_markdown.root,
                    3,
                    "text/markdown",
                    parser_provenance.provenance_id.root,
                    "1.0",
                    None,
                    None,
                ),
            )
            connection.execute(
                "INSERT INTO literature_contents(literature_id,literature_content_sha256,"
                "metadata_revision,metadata_sha256,primary_asset_id,primary_asset_sha256,"
                "parser_result_sha256,structured_artifact_path,structured_artifact_sha256,"
                "structured_artifact_byte_size,structured_artifact_media_type,"
                "markdown_artifact_path,markdown_artifact_sha256,markdown_artifact_byte_size,"
                "markdown_artifact_media_type,analysis_provenance_id) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    literature.literature_id.root,
                    Sha256("e" * 64).root,
                    1,
                    metadata_sha256(literature.metadata).root,
                    result.asset.asset_id.root,
                    result.asset.sha256.root,
                    parser_result.root,
                    paths[1],
                    structured.root,
                    4,
                    "application/json",
                    paths[2],
                    markdown.root,
                    5,
                    "text/markdown",
                    analysis_provenance.provenance_id.root,
                ),
            )
            connection.execute(
                "DELETE FROM literature_assets WHERE literature_asset_id=?",
                (result.relation.literature_asset_id.root,),
            )

    def test_every_primary_transaction_failpoint_rolls_back_all_catalog_rows(self) -> None:
        checkpoints = (
            "primary-after-preconditions",
            "primary-after-artifact",
            "primary-after-asset",
            "primary-after-provenance",
            "primary-after-relation",
            "primary-after-exhaustion-clear",
            "primary-after-final-file-check",
            "primary-before-commit",
        )
        payload = _pdf_bytes()
        digest = sha256_digest(payload)
        for index, checkpoint in enumerate(checkpoints, start=70):
            with self.subTest(checkpoint=checkpoint):
                environment = self._new_environment()
                self._insert_exhaustion(environment, 0)
                before = self._acquisition_snapshot(environment)
                adapter = self._adapter(environment, failpoint=_fail_at(checkpoint))
                temporary, _ = _temporary_pdf(payload, index=index)
                request = _request(environment, 0)
                with self.assertRaises(AcquisitionFailure):
                    _prepare_and_commit(
                        self._publisher(
                            environment=environment,
                            adapter=adapter,
                            id_index=index,
                        ),
                        request,
                        temporary,
                    )
                self.assertEqual(self._acquisition_snapshot(environment), before)
                reference = content_addressed_reference(digest, len(payload))
                with environment.reader.open(
                    reference,
                    sha256=digest,
                    byte_size=len(payload),
                    media_type="application/pdf",
                ) as stream:
                    self.assertEqual(stream.read(), payload)

    def test_file_damage_or_loss_in_each_registration_window_never_creates_catalog_reference(
        self,
    ) -> None:
        windows = (
            ("primary-before-prepare", "damage"),
            ("primary-after-prepare", "missing"),
            ("primary-after-artifact", "damage"),
            ("primary-after-final-file-check", "damage"),
        )
        payload = _pdf_bytes(width=81)
        digest = sha256_digest(payload)
        reference = content_addressed_reference(digest, len(payload))
        for index, (window, action) in enumerate(windows, start=90):
            with self.subTest(window=window):
                environment = self._new_environment()
                formal = environment.root.canonical_path / reference.root

                def mutate(name: str, *, expected: str = window, operation: str = action) -> None:
                    if name != expected:
                        return
                    if operation == "missing":
                        formal.unlink()
                    else:
                        formal.write_bytes(b"x" * len(payload))
                        os.chmod(formal, 0o600)

                adapter = self._adapter(environment, failpoint=mutate)
                temporary, _ = _temporary_pdf(payload, index=index)
                request = _request(environment, 0)
                with self.assertRaises(AcquisitionFailure):
                    _prepare_and_commit(
                        self._publisher(
                            environment=environment,
                            adapter=adapter,
                            id_index=index,
                        ),
                        request,
                        temporary,
                    )
                self.assertEqual(self._table_rows(environment, "artifact_objects"), ())
                self.assertEqual(self._table_rows(environment, "assets"), ())
                self.assertEqual(self._table_rows(environment, "literature_assets"), ())

    def test_exhaustion_publication_is_idempotent_and_rechecks_all_current_facts(self) -> None:
        adapter = self._adapter()
        literature = self.environment.literatures[0]
        command = AcquisitionExhaustionPublicationCommand(
            expected_facts=_expected(literature),
            observation_ids=(self.environment.observations[0].observation_id,),
        )
        first = adapter.publish_exhaustion(command)
        second = adapter.publish_exhaustion(command)
        self.assertEqual(
            first, AutomaticPdfAcquisitionExhaustion(literature_id=literature.literature_id)
        )
        self.assertEqual(second, first)
        self.assertEqual(
            self._table_rows(self.environment, "automatic_pdf_acquisition_exhaustions"),
            ((literature.literature_id.root,),),
        )

        stale_commands = (
            AcquisitionExhaustionPublicationCommand(
                expected_facts=_expected(literature, metadata_revision=2),
                observation_ids=command.observation_ids,
            ),
            AcquisitionExhaustionPublicationCommand(
                expected_facts=_expected(literature),
                observation_ids=(),
            ),
        )
        for stale in stale_commands:
            with self.assertRaises(AcquisitionPublicationError):
                adapter.publish_exhaustion(stale)
        self.assertEqual(
            self._table_rows(self.environment, "automatic_pdf_acquisition_exhaustions"),
            ((literature.literature_id.root,),),
        )

    def test_exhaustion_rejects_primary_or_content(self) -> None:
        command = AcquisitionExhaustionPublicationCommand(
            expected_facts=_expected(self.environment.literatures[0]),
            observation_ids=(self.environment.observations[0].observation_id,),
        )
        result, _ = self._publish(id_index=110)
        with self.assertRaises(AcquisitionPublicationError):
            self._adapter().publish_exhaustion(command)
        with self.environment.engine.write_transaction() as connection:
            connection.execute(
                "DELETE FROM literature_assets WHERE literature_asset_id=?",
                (result.relation.literature_asset_id.root,),
            )
        self._insert_aligned_content_and_remove_relation_for_existing_asset(result)
        with self.assertRaises(AcquisitionPublicationError):
            self._adapter().publish_exhaustion(command)

    def _insert_aligned_content_and_remove_relation_for_existing_asset(
        self,
        result: AcquiredPrimaryPdf,
    ) -> None:
        with self.environment.engine.write_transaction() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO literature_assets("
                "literature_asset_id,literature_id,asset_id,"
                "role,provenance_id,source_url) VALUES(?,?,?,?,?,?)",
                (
                    result.relation.literature_asset_id.root,
                    result.relation.literature_id.root,
                    result.relation.asset_id.root,
                    result.relation.role.value,
                    result.relation.provenance.provenance_id.root,
                    result.relation.source_url,
                ),
            )
        self._insert_aligned_content_and_remove_relation(result)

    def _publish_new_observation(self, environment: _Environment, index: int) -> ObservationId:
        literature = environment.literatures[0]
        observation = _observation(index, literature)
        environment.writer.publish_identity_and_observation(
            IdentityObservationPublicationCommand(
                literatures=(literature,),
                meta_literatures=(),
                observations=(
                    LiteratureObservation(
                        literature_id=literature.literature_id,
                        observation=observation,
                    ),
                ),
                facts=(
                    CurrentLiteratureFacts(
                        literature=literature,
                        metadata_revision=1,
                        metadata_sha256=metadata_sha256(literature.metadata),
                    ),
                ),
                expected_tokens=(
                    LiteratureIdentityToken(
                        literature_id=literature.literature_id,
                        meta_literature_id=literature.meta_literature_id,
                        metadata_revision=1,
                        metadata_sha256=metadata_sha256(literature.metadata),
                    ),
                ),
                expected_meta_tokens=(),
                clear_automatic_pdf_exhaustion_for=(literature.literature_id,),
            )
        )
        return observation.observation_id

    def test_new_observation_race_in_both_commit_orders_never_leaves_stale_exhaustion(self) -> None:
        first = self._new_environment()
        old_command = AcquisitionExhaustionPublicationCommand(
            expected_facts=_expected(first.literatures[0]),
            observation_ids=(first.observations[0].observation_id,),
        )
        self._adapter(first).publish_exhaustion(old_command)
        self._publish_new_observation(first, 120)
        self.assertEqual(
            self._table_rows(first, "automatic_pdf_acquisition_exhaustions"),
            (),
        )

        second = self._new_environment()
        self._publish_new_observation(second, 121)
        with self.assertRaises(AcquisitionPublicationError):
            self._adapter(second).publish_exhaustion(
                AcquisitionExhaustionPublicationCommand(
                    expected_facts=_expected(second.literatures[0]),
                    observation_ids=(second.observations[0].observation_id,),
                )
            )
        self.assertEqual(
            self._table_rows(second, "automatic_pdf_acquisition_exhaustions"),
            (),
        )

    def test_every_exhaustion_failpoint_rolls_back(self) -> None:
        checkpoints = (
            "exhaustion-after-preconditions",
            "exhaustion-after-observation-closure",
            "exhaustion-after-insert",
            "exhaustion-before-commit",
        )
        for checkpoint in checkpoints:
            with self.subTest(checkpoint=checkpoint):
                environment = self._new_environment()
                command = AcquisitionExhaustionPublicationCommand(
                    expected_facts=_expected(environment.literatures[0]),
                    observation_ids=(environment.observations[0].observation_id,),
                )
                with self.assertRaises(AcquisitionPublicationError):
                    self._adapter(
                        environment,
                        failpoint=_fail_at(checkpoint),
                    ).publish_exhaustion(command)
                self.assertEqual(
                    self._table_rows(environment, "automatic_pdf_acquisition_exhaustions"),
                    (),
                )

    def test_explicit_retry_clear_is_idempotent_and_rejects_stale_primary_or_content(self) -> None:
        adapter = self._adapter()
        facts = _expected(self.environment.literatures[0])
        adapter.clear_exhaustion(facts)
        self._insert_exhaustion(self.environment, 0)
        adapter.clear_exhaustion(facts)
        adapter.clear_exhaustion(facts)
        self.assertEqual(
            self._table_rows(self.environment, "automatic_pdf_acquisition_exhaustions"),
            (),
        )

        self._insert_exhaustion(self.environment, 0)
        with self.assertRaises(AcquisitionPublicationError):
            adapter.clear_exhaustion(
                _expected(self.environment.literatures[0], metadata_revision=2)
            )
        self.assertEqual(
            self._table_rows(self.environment, "automatic_pdf_acquisition_exhaustions"),
            ((self.environment.literatures[0].literature_id.root,),),
        )
        result, _ = self._publish(id_index=130)
        with self.environment.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO automatic_pdf_acquisition_exhaustions(literature_id) VALUES(?)",
                (self.environment.literatures[0].literature_id.root,),
            )
        with self.assertRaises(AcquisitionPublicationError):
            adapter.clear_exhaustion(facts)
        with self.environment.engine.write_transaction() as connection:
            connection.execute(
                "DELETE FROM literature_assets WHERE literature_asset_id=?",
                (result.relation.literature_asset_id.root,),
            )
        self._insert_aligned_content_and_remove_relation_for_existing_asset(result)
        with self.assertRaises(AcquisitionPublicationError):
            adapter.clear_exhaustion(facts)

    def test_every_retry_clear_failpoint_preserves_existing_exhaustion(self) -> None:
        checkpoints = (
            "retry-after-preconditions",
            "retry-after-delete",
            "retry-before-commit",
        )
        for checkpoint in checkpoints:
            with self.subTest(checkpoint=checkpoint):
                environment = self._new_environment()
                self._insert_exhaustion(environment, 0)
                with self.assertRaises(AcquisitionPublicationError):
                    self._adapter(
                        environment,
                        failpoint=_fail_at(checkpoint),
                    ).clear_exhaustion(_expected(environment.literatures[0]))
                self.assertEqual(
                    self._table_rows(environment, "automatic_pdf_acquisition_exhaustions"),
                    ((environment.literatures[0].literature_id.root,),),
                )

    def test_candidate_rejection_is_the_only_normal_none_and_all_other_failures_are_stable(
        self,
    ) -> None:
        request = _request(self.environment, 0)
        invalid, invalid_content = _temporary_pdf(b"<html>not pdf</html>", index=140)
        result = _prepare_and_commit(self._publisher(id_index=140), request, invalid)
        self.assertIsNone(result)
        self.assertEqual(invalid_content.open_calls, 1)
        self.assertEqual(invalid_content.discard_calls, 1)

        failures: tuple[BaseException | BinaryIO, ...] = (
            _ExplodingReader(),
            OSError("temporary open failed"),
            PdfValidationError(PdfValidationCode.NOT_PDF),
        )
        for index, source in enumerate(failures, start=141):
            with self.subTest(index=index):
                temporary, content = _temporary_pdf(source, index=index)
                with self.assertRaises(AcquisitionFailure) as raised:
                    _prepare_and_commit(self._publisher(id_index=index), request, temporary)
                self.assertTrue(raised.exception.failure.code)
                self.assertEqual(content.open_calls, 1)
                self.assertEqual(content.discard_calls, 1)

        validation_failures = (
            PdfValidationCancelled(),
            PdfValidationStagingError(),
            PdfValidationError(PdfValidationCode.SOURCE_ERROR),
        )
        for index, failure in enumerate(validation_failures, start=150):
            with self.subTest(failure=type(failure).__name__):
                temporary, content = _temporary_pdf(_pdf_bytes(), index=index)
                with mock.patch(
                    "sciretriever.acquisition.publication.validate_pdf",
                    side_effect=failure,
                ):
                    with self.assertRaises(AcquisitionFailure):
                        _prepare_and_commit(self._publisher(id_index=index), request, temporary)
                self.assertEqual(content.discard_calls, 1)
        self.assertEqual(
            self._table_rows(self.environment, "automatic_pdf_acquisition_exhaustions"),
            (),
        )

    def test_store_lease_sql_and_cas_failures_are_acquisition_failures_without_exhaustion(
        self,
    ) -> None:
        request = _request(self.environment, 0)
        temporary, _ = _temporary_pdf(_pdf_bytes(width=160), index=160)
        with mock.patch.object(
            ArtifactStore,
            "publish",
            side_effect=ArtifactStoreError(),
        ):
            with self.assertRaises(AcquisitionFailure):
                _prepare_and_commit(self._publisher(id_index=160), request, temporary)

        temporary, _ = _temporary_pdf(_pdf_bytes(width=161), index=161)
        with mock.patch.object(
            VerifiedReader,
            "acquire",
            side_effect=VerifiedReaderError(),
        ):
            with self.assertRaises(AcquisitionFailure):
                _prepare_and_commit(self._publisher(id_index=161), request, temporary)

        temporary, _ = _temporary_pdf(_pdf_bytes(width=162), index=162)
        with self.assertRaises(AcquisitionFailure):
            _prepare_and_commit(
                self._publisher(
                    adapter=self._adapter(failpoint=_fail_at("primary-after-artifact")),
                    id_index=162,
                ),
                request,
                temporary,
            )

        stale = _expected(self.environment.literatures[0], metadata_revision=2)
        stale_request = AcquisitionRequest(
            literature=self.environment.literatures[0],
            expected_facts=stale,
            observations=(self.environment.observations[0],),
        )
        temporary, _ = _temporary_pdf(_pdf_bytes(width=170), index=170)
        with self.assertRaises(AcquisitionFailure):
            _prepare_and_commit(self._publisher(id_index=170), stale_request, temporary)
        self.assertEqual(
            self._table_rows(self.environment, "automatic_pdf_acquisition_exhaustions"),
            (),
        )

    def test_exhaustion_schema_and_catalog_do_not_persist_runtime_attempt_details(self) -> None:
        candidate_key = "runtime-candidate-must-not-persist"
        result, _ = self._publish(id_index=180, candidate_key=candidate_key)
        self.assertEqual(result.candidate_key, candidate_key)
        with self.environment.engine.read_snapshot() as connection:
            columns = tuple(
                row[1]
                for row in connection.execute(
                    'PRAGMA table_info("automatic_pdf_acquisition_exhaustions")'
                )
            )
            persisted = tuple(
                tuple(row)
                for table in (
                    "artifact_objects",
                    "assets",
                    "literature_assets",
                    "automatic_pdf_acquisition_exhaustions",
                )
                for row in connection.execute(f'SELECT * FROM "{table}"')
            )
        self.assertEqual(columns, ("literature_id",))
        rendered = repr(persisted)
        for forbidden in (
            candidate_key,
            "candidate-reason",
            "attempt-count",
            "source-attempt",
            "configuration-snapshot",
        ):
            self.assertNotIn(forbidden, rendered)


if __name__ == "__main__":
    unittest.main()
