from __future__ import annotations

import os
import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sciretriever.literature.api import LiteratureApi
from sciretriever.literature.content import metadata_sha256
from sciretriever.literature.exchange import (
    BibliographicObservationError,
    ExportSelectionError,
    observation_from_bibliographic_record,
    select_export_literatures,
)
from sciretriever.literature.ports import (
    IdentityObservationPublicationCommand,
    IdentityReadContext,
    IdentityReadRequest,
    LiteratureArtifactReadPort,
    LiteratureObservation,
)
from sciretriever.literature.ports import (
    LiteratureArtifactReadError as LiteratureOwnedArtifactReadError,
)
from sciretriever.literature.ports import (
    LiteratureArtifactReference as LiteratureOwnedArtifactReference,
)
from sciretriever.literature.service import LiteratureService
from sciretriever.literature.state import (
    CurrentContentLineage,
    CurrentLiteratureFacts,
    CurrentPrimaryPdf,
)
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
    ReferenceId,
    RelativeArtifactPath,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.record import BibliographicRecord
from sciretriever.storage.files.paths import StorageRoot
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactReference, ArtifactStore
from sciretriever.storage.literature_artifacts import (
    LiteratureArtifactReader,
    LiteratureArtifactReadError,
    LiteratureArtifactReference,
)
from sciretriever.storage.sqlite.artifacts import register_artifact
from sciretriever.storage.sqlite.engine import CatalogEngine

_ID_1 = "123e4567-e89b-12d3-a456-426614174000"
_ID_2 = "223e4567-e89b-12d3-a456-426614174000"
_ID_3 = "323e4567-e89b-12d3-a456-426614174000"
_ID_4 = "423e4567-e89b-12d3-a456-426614174000"
_ID_5 = "523e4567-e89b-12d3-a456-426614174000"
_ID_6 = "623e4567-e89b-12d3-a456-426614174000"
_ID_7 = "723e4567-e89b-12d3-a456-426614174000"
_ID_8 = "823e4567-e89b-12d3-a456-426614174000"
_TIMESTAMP = UtcTimestamp("2026-08-11T08:30:00Z")


def _metadata(
    title: str | None = "Accepted metadata",
    *,
    identifiers: tuple[Identifier, ...] | None = None,
) -> LiteratureMetadata:
    return LiteratureMetadata(
        title=title,
        identifiers=(
            (Identifier(namespace="doi", value="10.1000/exchange"),)
            if identifiers is None
            else identifiers
        ),
    )


def _literature(
    identifier: str,
    *,
    meta_id: str = _ID_1,
    role: VersionRole = VersionRole.OTHER,
    status: LiteratureStatus = LiteratureStatus.UNREVIEWED,
    metadata: LiteratureMetadata | None = None,
) -> Literature:
    return Literature(
        literature_id=LiteratureId(identifier),
        meta_literature_id=MetaLiteratureId(meta_id),
        version_role=role,
        metadata=_metadata() if metadata is None else metadata,
        status=status,
    )


def _import_provenance(
    *,
    identifier: str = _ID_3,
    source_kind: SourceKind = SourceKind.USER,
    source_name: str = "bibliographic-import",
    source_record_id: str | None = None,
    input_sha256: Sha256 | None = None,
    parameters_sha256: Sha256 | None = None,
) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(identifier),
        source_kind=source_kind,
        source_name=source_name,
        source_record_id=source_record_id,
        observed_at=_TIMESTAMP,
        input_sha256=input_sha256,
        parameters_sha256=parameters_sha256,
    )


def _provider_observation(
    observation_id: str,
    metadata: LiteratureMetadata,
    *,
    source_record_id: str = "provider-record",
) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(observation_id),
        provenance=_import_provenance(
            identifier=observation_id,
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name="provider",
            source_record_id=source_record_id,
            input_sha256=Sha256("b" * 64),
        ),
        metadata=metadata,
    )


class _AcceptanceIds:
    def __init__(self) -> None:
        self._literature_ids = iter((_ID_5, _ID_6))
        self._meta_ids = iter((_ID_7, _ID_8))

    def new_literature_id(self) -> LiteratureId:
        return LiteratureId(next(self._literature_ids))

    def new_meta_literature_id(self) -> MetaLiteratureId:
        return MetaLiteratureId(next(self._meta_ids))

    def new_reference_id(self) -> ReferenceId:
        return ReferenceId(_ID_4)


class _AcceptanceMemory:
    """Minimal Port fake that keeps the real Literature admission algorithm."""

    def __init__(self) -> None:
        self.literatures: tuple[Literature, ...] = ()
        self.meta_literatures: tuple[MetaLiterature, ...] = ()
        self.observations: tuple[LiteratureObservation, ...] = ()
        self.facts: tuple[CurrentLiteratureFacts, ...] = ()
        self.identity_commands: list[IdentityObservationPublicationCommand] = []

    def read_identity(self, request: IdentityReadRequest) -> IdentityReadContext:
        del request
        return IdentityReadContext(
            literatures=self.literatures,
            meta_literatures=self.meta_literatures,
            observations=self.observations,
            facts=self.facts,
        )

    def publish_identity_and_observation(
        self,
        command: IdentityObservationPublicationCommand,
    ) -> None:
        self.identity_commands.append(command)
        literatures = list(self.literatures)
        for item in command.literatures:
            literatures = [
                current for current in literatures if current.literature_id != item.literature_id
            ]
            literatures.append(item)
        metas = [
            item
            for item in self.meta_literatures
            if item.meta_literature_id not in command.retired_meta_literature_ids
        ]
        for item in command.meta_literatures:
            metas = [
                current
                for current in metas
                if current.meta_literature_id != item.meta_literature_id
            ]
            metas.append(item)
        facts = list(self.facts)
        for item in command.facts:
            facts = [
                current
                for current in facts
                if current.literature.literature_id != item.literature.literature_id
            ]
            facts.append(item)
        observations = list(self.observations)
        observations.extend(item for item in command.observations if item not in observations)
        self.literatures = tuple(literatures)
        self.meta_literatures = tuple(metas)
        self.facts = tuple(facts)
        self.observations = tuple(observations)

    def make_content_ready(self, literature_id: LiteratureId) -> CurrentLiteratureFacts:
        facts = next(item for item in self.facts if item.literature.literature_id == literature_id)
        literature = facts.literature.model_copy(update={"status": LiteratureStatus.CONTENT_READY})
        pdf_hash = sha256_digest(b"content-ready-pdf")
        asset = Asset(
            asset_id=AssetId(_ID_1),
            sha256=pdf_hash,
            size_bytes=17,
            media_type="application/pdf",
            path=RelativeArtifactPath("pdf/content-ready.pdf"),
        )
        relation = LiteratureAsset(
            literature_asset_id=LiteratureAssetId(_ID_2),
            literature_id=literature_id,
            asset_id=asset.asset_id,
            role=AssetRole.PRIMARY_PDF,
            provenance=Provenance(
                provenance_id=ProvenanceId(_ID_1),
                source_kind=SourceKind.ASSET_PROVIDER,
                source_name="fixture-asset",
                source_record_id=None,
                observed_at=_TIMESTAMP,
                input_sha256=pdf_hash,
                parameters_sha256=None,
            ),
        )
        parser_parameters = Sha256("d" * 64)
        parser_markdown = ParserArtifactRef(
            sha256=Sha256("e" * 64),
            media_type="text/markdown",
            byte_size=1,
        )
        parser_provenance = ParserProvenance(
            provenance=Provenance(
                provenance_id=ProvenanceId(_ID_2),
                source_kind=SourceKind.PARSER,
                source_name="fixture-parser",
                source_record_id=None,
                observed_at=_TIMESTAMP,
                input_sha256=pdf_hash,
                parameters_sha256=parser_parameters,
            ),
            parser_version="1",
        )
        parser_hash = parser_result_sha256(
            source_asset_id=asset.asset_id,
            source_sha256=asset.sha256,
            page_count=1,
            markdown=parser_markdown,
            resources=(),
            provenance=parser_provenance,
        )
        parser = ParserResult(
            source_asset_id=asset.asset_id,
            source_sha256=asset.sha256,
            page_count=1,
            markdown=parser_markdown,
            result_sha256=parser_hash,
            provenance=parser_provenance,
        )
        sections = tuple(
            LiteratureSection(role=role, markdown="fixture")
            for role in (
                LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
                LiteratureSectionRole.METHODS,
                LiteratureSectionRole.DATA,
                LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
            )
        )
        current_metadata_hash = metadata_sha256(literature.metadata)
        content = LiteratureContent(
            literature_content_sha256=content_sha256(
                metadata_sha256=current_metadata_hash,
                sections=sections,
                references=(),
            ),
            metadata_revision=facts.metadata_revision,
            metadata_sha256=current_metadata_hash,
            sections=sections,
            references=(),
            markdown=ArtifactRef(
                sha256=Sha256("f" * 64),
                media_type="text/markdown",
                byte_size=1,
            ),
            provenance=Provenance(
                provenance_id=ProvenanceId(_ID_3),
                source_kind=SourceKind.ANALYSIS,
                source_name="fixture-analysis",
                source_record_id=None,
                observed_at=_TIMESTAMP,
                input_sha256=analysis_input_sha256(
                    pdf_hash,
                    parser_hash,
                    current_metadata_hash,
                ),
                parameters_sha256=Sha256("a" * 64),
            ),
        )
        ready = CurrentLiteratureFacts(
            literature=literature,
            metadata_revision=facts.metadata_revision,
            metadata_sha256=current_metadata_hash,
            current_primary_pdfs=(CurrentPrimaryPdf(asset=asset, relation=relation),),
            current_parser_result=parser,
            current_content=content,
            current_content_lineage=CurrentContentLineage(
                primary_asset_id=asset.asset_id,
                primary_pdf_sha256=pdf_hash,
                parser_result_sha256=parser_hash,
            ),
        )
        self.literatures = tuple(
            literature if item.literature_id == literature_id else item for item in self.literatures
        )
        self.facts = tuple(
            ready if item.literature.literature_id == literature_id else item for item in self.facts
        )
        return ready


def _acceptance_api() -> tuple[LiteratureApi, _AcceptanceMemory]:
    memory = _AcceptanceMemory()
    service = LiteratureService(
        read_port=memory,  # type: ignore[arg-type]
        identity_port=memory,
        content_port=memory,  # type: ignore[arg-type]
        reference_port=memory,  # type: ignore[arg-type]
        maintenance_port=memory,  # type: ignore[arg-type]
        id_factory=_AcceptanceIds(),
    )
    return LiteratureApi(service), memory


class LiteratureExchangeRuleTests(unittest.TestCase):
    def test_bibliographic_record_forms_one_plain_user_observation(self) -> None:
        metadata = _metadata("Imported title")
        record = BibliographicRecord(record_index=7, metadata=metadata)
        provenance = _import_provenance()
        observation_id = ObservationId(_ID_4)

        observation = observation_from_bibliographic_record(
            record,
            observation_id=observation_id,
            provenance=provenance,
        )

        self.assertEqual(observation.observation_id, observation_id)
        self.assertIs(observation.metadata, metadata)
        self.assertIs(observation.provenance, provenance)
        self.assertIsNone(observation.version_role)
        self.assertEqual(observation.version_links, ())
        self.assertEqual(observation.declared_keywords, ())
        self.assertEqual(observation.reference_texts, ())
        self.assertEqual(observation.asset_hints, ())
        self.assertIsNone(observation.reference_count)
        self.assertIsNone(observation.cited_by_count)

    def test_bibliographic_observation_requires_caller_supplied_fixed_provenance(self) -> None:
        record = BibliographicRecord(record_index=0, metadata=_metadata())
        invalid_values = (
            _import_provenance(
                source_kind=SourceKind.METADATA_PROVIDER,
                source_name="provider",
                source_record_id="record-1",
                input_sha256=Sha256("a" * 64),
            ),
            _import_provenance(source_name="manual-entry"),
            _import_provenance(source_record_id="external-tool-id"),
            _import_provenance(input_sha256=Sha256("b" * 64)),
            _import_provenance(parameters_sha256=Sha256("c" * 64)),
        )

        for provenance in invalid_values:
            with self.subTest(provenance=provenance):
                with self.assertRaises(BibliographicObservationError):
                    observation_from_bibliographic_record(
                        record,
                        observation_id=ObservationId(_ID_4),
                        provenance=provenance,
                    )

    def test_bibliographic_construction_does_not_repeat_literature_admission(self) -> None:
        record = BibliographicRecord(record_index=0, metadata=LiteratureMetadata())

        observation = observation_from_bibliographic_record(
            record,
            observation_id=ObservationId(_ID_4),
            provenance=_import_provenance(),
        )

        self.assertEqual(observation.metadata, LiteratureMetadata())

    def test_metadata_only_representative_is_exportable_by_default(self) -> None:
        representative = _literature(
            _ID_2,
            role=VersionRole.PUBLISHED,
            status=LiteratureStatus.UNREVIEWED,
        )
        preprint = _literature(
            _ID_3,
            role=VersionRole.PREPRINT,
            status=LiteratureStatus.CONTENT_READY,
        )
        meta = MetaLiterature(
            meta_literature_id=MetaLiteratureId(_ID_1),
            representative_literature_id=representative.literature_id,
        )

        selected = select_export_literatures(meta, (preprint, representative))

        self.assertEqual(selected, (representative,))
        self.assertIs(selected[0].metadata, representative.metadata)

    def test_all_export_versions_use_role_then_literature_id_order(self) -> None:
        members = (
            _literature(_ID_7, role=VersionRole.OTHER),
            _literature(_ID_5, role=VersionRole.PUBLISHED),
            _literature(_ID_8, role=VersionRole.PREPRINT),
            _literature(_ID_6, role=VersionRole.ACCEPTED_MANUSCRIPT),
            _literature(_ID_4, role=VersionRole.PUBLISHED),
        )
        meta = MetaLiterature(
            meta_literature_id=MetaLiteratureId(_ID_1),
            representative_literature_id=LiteratureId(_ID_4),
        )

        selected = select_export_literatures(meta, members, all_versions=True)

        self.assertEqual(
            tuple(str(item.literature_id) for item in selected),
            (_ID_4, _ID_5, _ID_6, _ID_8, _ID_7),
        )

    def test_export_selection_rejects_empty_duplicate_foreign_or_missing_representative(
        self,
    ) -> None:
        representative = _literature(_ID_2)
        meta = MetaLiterature(
            meta_literature_id=MetaLiteratureId(_ID_1),
            representative_literature_id=representative.literature_id,
        )
        foreign = _literature(_ID_3, meta_id=_ID_4)
        cases = (
            (),
            (_literature(_ID_3),),
            (representative, representative),
            (representative, foreign),
        )

        for members in cases:
            with self.subTest(members=members):
                with self.assertRaises(ExportSelectionError):
                    select_export_literatures(meta, members)

    def test_export_selection_requires_accepted_metadata_and_the_deterministic_representative(
        self,
    ) -> None:
        invalid_metadata = _literature(
            _ID_2,
            role=VersionRole.PUBLISHED,
            metadata=LiteratureMetadata(),
        )
        preprint = _literature(_ID_3, role=VersionRole.PREPRINT)
        invalid_metadata_meta = MetaLiterature(
            meta_literature_id=MetaLiteratureId(_ID_1),
            representative_literature_id=invalid_metadata.literature_id,
        )
        with self.assertRaises(ExportSelectionError):
            select_export_literatures(invalid_metadata_meta, (invalid_metadata,))

        wrong_representative_meta = MetaLiterature(
            meta_literature_id=MetaLiteratureId(_ID_1),
            representative_literature_id=preprint.literature_id,
        )
        published = _literature(_ID_4, role=VersionRole.PUBLISHED)
        with self.assertRaises(ExportSelectionError):
            select_export_literatures(
                wrong_representative_meta,
                (preprint, published),
            )

    def test_all_versions_complete_closure_is_an_explicit_caller_precondition(self) -> None:
        representative = _literature(_ID_2, role=VersionRole.PUBLISHED)
        meta = MetaLiterature(
            meta_literature_id=MetaLiteratureId(_ID_1),
            representative_literature_id=representative.literature_id,
        )

        selected = select_export_literatures(meta, (representative,), all_versions=True)

        self.assertEqual(selected, (representative,))

    def test_export_member_materialization_maps_ordinary_errors_but_preserves_base_exception(
        self,
    ) -> None:
        representative = _literature(_ID_2, role=VersionRole.PUBLISHED)
        meta = MetaLiterature(
            meta_literature_id=MetaLiteratureId(_ID_1),
            representative_literature_id=representative.literature_id,
        )

        def ordinary_failure() -> Iterator[Literature]:
            yield representative
            raise RuntimeError("private iterator detail")

        with self.assertRaises(ExportSelectionError) as caught:
            select_export_literatures(meta, ordinary_failure())
        self.assertEqual(str(caught.exception), "bibliographic export selection is invalid")
        self.assertIsNone(caught.exception.__cause__)

        def cancellation() -> Iterator[Literature]:
            yield representative
            raise KeyboardInterrupt

        with self.assertRaises(KeyboardInterrupt):
            select_export_literatures(meta, cancellation())


class LiteratureBibliographicApiTests(unittest.TestCase):
    def test_record_enters_the_one_real_identity_admission_flow(self) -> None:
        api, memory = _acceptance_api()
        metadata = _metadata("Imported title")
        result = api.accept_bibliographic_record(
            BibliographicRecord(record_index=4, metadata=metadata),
            observation_id=ObservationId(_ID_4),
            provenance=_import_provenance(),
        )

        self.assertEqual(result.decision, "created")
        self.assertFalse(result.deduplicated)
        self.assertEqual(len(memory.identity_commands), 1)
        self.assertEqual(len(memory.literatures), 1)
        self.assertEqual(len(memory.meta_literatures), 1)
        self.assertEqual(len(memory.facts), 1)
        self.assertEqual(len(memory.observations), 1)
        self.assertEqual(memory.literatures[0].metadata, metadata)
        observation = memory.observations[0].observation
        self.assertIs(observation.provenance.source_kind, SourceKind.USER)
        self.assertEqual(observation.provenance.source_name, "bibliographic-import")

    def test_record_change_enriches_but_equal_value_matches_and_is_retained(self) -> None:
        api, memory = _acceptance_api()
        doi = Identifier(namespace="doi", value="10.1000/api-exchange")
        provider_metadata = _metadata("Provider title", identifiers=(doi,))
        created = api.accept_observation(_provider_observation(_ID_1, provider_metadata))
        assert created.literature is not None

        changed = api.accept_bibliographic_record(
            BibliographicRecord(
                record_index=1,
                metadata=_metadata("User title", identifiers=(doi,)),
            ),
            observation_id=ObservationId(_ID_3),
            provenance=_import_provenance(identifier=_ID_3),
        )

        self.assertEqual(changed.decision, "enriched")
        self.assertFalse(changed.deduplicated)
        self.assertEqual(len(memory.literatures), 1)
        self.assertEqual(len(memory.observations), 2)

        equal_api, equal_memory = _acceptance_api()
        equal_api.accept_observation(_provider_observation(_ID_1, provider_metadata))
        equal = equal_api.accept_bibliographic_record(
            BibliographicRecord(record_index=2, metadata=provider_metadata),
            observation_id=ObservationId(_ID_3),
            provenance=_import_provenance(identifier=_ID_3),
        )

        self.assertEqual(equal.decision, "matched")
        self.assertFalse(equal.deduplicated)
        self.assertEqual(len(equal_memory.observations), 2)
        self.assertEqual(len(equal_memory.identity_commands), 2)

    def test_semantic_record_replay_matches_without_a_second_publication(self) -> None:
        api, memory = _acceptance_api()
        metadata = _metadata(
            "Replay title",
            identifiers=(Identifier(namespace="doi", value="10.1000/replay"),),
        )
        first = api.accept_bibliographic_record(
            BibliographicRecord(record_index=0, metadata=metadata),
            observation_id=ObservationId(_ID_3),
            provenance=_import_provenance(identifier=_ID_3),
        )
        replay = api.accept_bibliographic_record(
            BibliographicRecord(record_index=9, metadata=metadata),
            observation_id=ObservationId(_ID_4),
            provenance=_import_provenance(identifier=_ID_4),
        )

        self.assertEqual(first.decision, "created")
        self.assertEqual(replay.decision, "matched")
        self.assertTrue(replay.deduplicated)
        self.assertEqual(len(memory.observations), 1)
        self.assertEqual(len(memory.identity_commands), 1)

    def test_record_admission_rejects_missing_minimum_metadata_and_stable_id_conflict(
        self,
    ) -> None:
        empty_api, empty_memory = _acceptance_api()
        empty = empty_api.accept_bibliographic_record(
            BibliographicRecord(record_index=0, metadata=LiteratureMetadata()),
            observation_id=ObservationId(_ID_4),
            provenance=_import_provenance(),
        )

        self.assertEqual(empty.decision, "rejected")
        self.assertEqual(empty.reason, "missing-title-or-doi")
        self.assertEqual(empty_memory.identity_commands, [])

        conflict_api, conflict_memory = _acceptance_api()
        doi = Identifier(namespace="doi", value="10.1000/conflict")
        conflict_api.accept_observation(
            _provider_observation(
                _ID_1,
                _metadata(
                    "Provider title",
                    identifiers=(doi, Identifier(namespace="pmid", value="100")),
                ),
            )
        )
        conflict = conflict_api.accept_bibliographic_record(
            BibliographicRecord(
                record_index=1,
                metadata=_metadata(
                    "Imported title",
                    identifiers=(doi, Identifier(namespace="pmid", value="999")),
                ),
            ),
            observation_id=ObservationId(_ID_3),
            provenance=_import_provenance(identifier=_ID_3),
        )

        self.assertEqual(conflict.decision, "rejected")
        self.assertEqual(conflict.reason, "stable-identifier-conflict")
        self.assertEqual(len(conflict_memory.identity_commands), 1)
        self.assertEqual(len(conflict_memory.observations), 1)

    def test_content_ready_record_change_is_enriched_without_replacing_current_content(
        self,
    ) -> None:
        api, memory = _acceptance_api()
        doi = Identifier(namespace="doi", value="10.1000/content-ready-exchange")
        created = api.accept_observation(
            _provider_observation(
                _ID_1,
                _metadata("Provider title", identifiers=(doi,)),
            )
        )
        assert created.literature is not None
        before = memory.make_content_ready(created.literature.literature_id)
        observation_count = len(memory.observations)

        result = api.accept_bibliographic_record(
            BibliographicRecord(
                record_index=1,
                metadata=_metadata("Explicit user title", identifiers=(doi,)),
            ),
            observation_id=ObservationId(_ID_3),
            provenance=_import_provenance(identifier=_ID_3),
        )

        self.assertEqual(result.decision, "enriched")
        self.assertFalse(result.deduplicated)
        assert result.projection is not None
        self.assertTrue(result.projection.projection_preserved)
        self.assertTrue(result.projection.observations_projection_changed)
        self.assertEqual(len(memory.observations), observation_count + 1)
        self.assertEqual(memory.facts, (before,))

    def test_public_export_entry_is_the_same_pure_selection_without_admission(self) -> None:
        api, memory = _acceptance_api()
        representative = _literature(_ID_2, role=VersionRole.PUBLISHED)
        member = _literature(_ID_3, role=VersionRole.PREPRINT)
        meta = MetaLiterature(
            meta_literature_id=MetaLiteratureId(_ID_1),
            representative_literature_id=representative.literature_id,
        )

        selected = api.select_export_literatures(
            meta,
            (member, representative),
            all_versions=True,
        )

        self.assertEqual(
            selected,
            select_export_literatures(
                meta,
                (member, representative),
                all_versions=True,
            ),
        )
        self.assertEqual(memory.identity_commands, [])


class LiteratureArtifactReaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-literature-artifacts-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        os.chmod(self.base, 0o700)
        self.root = StorageRoot(self.base / "artifacts")
        self.store = ArtifactStore(self.root, max_artifact_bytes=1024)
        self.verified_reader = VerifiedReader(self.root, max_artifact_bytes=1024)
        self.engine = CatalogEngine(self.base / "catalog.sqlite")
        self.reader = LiteratureArtifactReader(self.engine, self.verified_reader)

    def test_storage_adapter_reexports_the_exact_literature_owned_port_contract(self) -> None:
        self.assertIs(LiteratureArtifactReadError, LiteratureOwnedArtifactReadError)
        self.assertIs(LiteratureArtifactReference, LiteratureOwnedArtifactReference)
        self.assertIn("open_artifact", LiteratureArtifactReadPort.__dict__)

    def _publish(
        self,
        artifact_id: str,
        payload: bytes,
        media_type: str,
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

    def test_asset_parser_and_content_references_open_verified_bytes(self) -> None:
        pdf_payload = b"not MIME-sniffed PDF bytes"
        parser_payload = b"# Parser Markdown\n"
        content_payload = b"# Canonical content\n"
        pdf = self._publish("asset-object", pdf_payload, "application/pdf")
        parser = self._publish("parser-object", parser_payload, "text/markdown")
        content = self._publish("content-object", content_payload, "text/markdown")
        asset = Asset(
            asset_id=AssetId(_ID_5),
            sha256=pdf.sha256,
            size_bytes=pdf.byte_size,
            media_type=pdf.media_type,
            path=pdf.path,
        )
        with self.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO assets(asset_id,sha256,size_bytes,media_type,relative_path) "
                "VALUES(?,?,?,?,?)",
                (
                    str(asset.asset_id),
                    str(asset.sha256),
                    asset.size_bytes,
                    asset.media_type,
                    str(asset.path),
                ),
            )
        parser_ref = ParserArtifactRef(
            sha256=parser.sha256,
            media_type=parser.media_type,
            byte_size=parser.byte_size,
        )
        content_ref = ArtifactRef(
            sha256=content.sha256,
            media_type=content.media_type,
            byte_size=content.byte_size,
        )

        for reference, expected in (
            (asset, pdf_payload),
            (parser_ref, parser_payload),
            (content_ref, content_payload),
        ):
            with self.subTest(reference=type(reference).__name__):
                with self.reader.open_artifact(reference) as stream:
                    self.assertEqual(stream.read(), expected)
                    self.assertFalse(stream.closed)
                self.assertTrue(stream.closed)

    def test_catalog_snapshot_closes_before_the_caller_owned_stream_lifecycle(self) -> None:
        payload = b"short Catalog snapshot"
        reference = self._publish("short-snapshot-object", payload, "application/octet-stream")
        model_ref = ArtifactRef(
            sha256=reference.sha256,
            media_type=reference.media_type,
            byte_size=reference.byte_size,
        )
        original_read_snapshot = CatalogEngine.read_snapshot
        active_snapshots = 0

        @contextmanager
        def tracked_read_snapshot(engine: CatalogEngine):
            nonlocal active_snapshots
            with original_read_snapshot(engine) as connection:
                active_snapshots += 1
                try:
                    yield connection
                finally:
                    active_snapshots -= 1

        with patch.object(CatalogEngine, "read_snapshot", tracked_read_snapshot):
            context = self.reader.open_artifact(model_ref)
            self.assertEqual(active_snapshots, 0)
            with context as stream:
                self.assertEqual(active_snapshots, 0)
                self.assertEqual(stream.read(), payload)
            self.assertEqual(active_snapshots, 0)

    def test_zero_byte_reference_fails_closed_before_catalog_or_file_access(self) -> None:
        digest = sha256_digest(b"")
        zero_values = (
            Asset(
                asset_id=AssetId(_ID_5),
                sha256=digest,
                size_bytes=0,
                media_type="application/octet-stream",
                path=RelativeArtifactPath(f".objects/{digest.root[:2]}/{digest.root}-0"),
            ),
            ParserArtifactRef(
                sha256=digest,
                media_type="application/octet-stream",
                byte_size=0,
            ),
            ArtifactRef(
                sha256=digest,
                media_type="application/octet-stream",
                byte_size=0,
            ),
        )

        for reference in zero_values:
            with self.subTest(reference=type(reference).__name__):
                with self.assertRaises(LiteratureArtifactReadError):
                    self.reader.open_artifact(reference)

    def test_catalog_missing_and_descriptor_mismatch_fail_closed(self) -> None:
        payload = b"catalog-bound bytes"
        registered = self._publish("catalog-object", payload, "application/octet-stream")
        missing_payload = b"published but not catalogued"
        missing = self.store.publish(
            missing_payload,
            sha256=sha256_digest(missing_payload),
            byte_size=len(missing_payload),
            media_type="application/octet-stream",
        )
        mismatched = ArtifactRef(
            sha256=registered.sha256,
            media_type="text/plain",
            byte_size=registered.byte_size,
        )

        for reference in (
            ParserArtifactRef(
                sha256=missing.sha256,
                media_type=missing.media_type,
                byte_size=missing.byte_size,
            ),
            mismatched,
        ):
            with self.subTest(reference=reference):
                with self.assertRaises(LiteratureArtifactReadError):
                    with self.reader.open_artifact(reference):
                        self.fail("an invalid Catalog reference returned a stream")

    def test_formal_catalog_reference_with_missing_file_fails_closed(self) -> None:
        payload = b"registered then missing"
        reference = self._publish("missing-file-object", payload, "application/octet-stream")
        model_ref = ArtifactRef(
            sha256=reference.sha256,
            media_type=reference.media_type,
            byte_size=reference.byte_size,
        )
        target = self.root.canonical_path / str(reference.path)
        target.unlink()

        with self.assertRaises(LiteratureArtifactReadError):
            with self.reader.open_artifact(model_ref):
                self.fail("a missing formal object returned a stream")

    def test_catalog_path_hash_size_and_media_must_all_match(self) -> None:
        payload = b"four-field Catalog identity"
        reference = self._publish("exact-object", payload, "application/octet-stream")
        model_ref = ArtifactRef(
            sha256=reference.sha256,
            media_type=reference.media_type,
            byte_size=reference.byte_size,
        )
        original = (
            str(reference.path),
            str(reference.sha256),
            reference.byte_size,
            reference.media_type,
        )
        mismatches = (
            (f".objects/ff/{'f' * 64}-{reference.byte_size}", *original[1:]),
            (original[0], "f" * 64, original[2], original[3]),
            (original[0], original[1], original[2] + 1, original[3]),
            (original[0], original[1], original[2], "application/x-mismatch"),
        )

        for mismatch in mismatches:
            with self.subTest(mismatch=mismatch):
                with self.engine.write_transaction() as connection:
                    connection.execute(
                        "UPDATE artifact_objects SET relative_path=?,sha256=?,byte_size=?,"
                        "media_type=? WHERE artifact_id='exact-object'",
                        mismatch,
                    )
                with self.assertRaises(LiteratureArtifactReadError):
                    with self.reader.open_artifact(model_ref):
                        self.fail("a Catalog-mismatched descriptor returned a stream")
                with self.engine.write_transaction() as connection:
                    connection.execute(
                        "UPDATE artifact_objects SET relative_path=?,sha256=?,byte_size=?,"
                        "media_type=? WHERE artifact_id='exact-object'",
                        original,
                    )

    def test_asset_id_row_is_required_and_must_match_the_descriptor(self) -> None:
        payload = b"asset bytes"
        reference = self._publish("asset-object", payload, "application/pdf")
        asset = Asset(
            asset_id=AssetId(_ID_5),
            sha256=reference.sha256,
            size_bytes=reference.byte_size,
            media_type=reference.media_type,
            path=reference.path,
        )

        with self.assertRaises(LiteratureArtifactReadError):
            with self.reader.open_artifact(asset):
                self.fail("an Asset absent from assets returned a stream")

        with self.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO assets(asset_id,sha256,size_bytes,media_type,relative_path) "
                "VALUES(?,?,?,?,?)",
                (
                    str(asset.asset_id),
                    str(asset.sha256),
                    asset.size_bytes,
                    asset.media_type,
                    str(asset.path),
                ),
            )
        altered = Asset(
            asset_id=asset.asset_id,
            sha256=asset.sha256,
            size_bytes=asset.size_bytes,
            media_type="application/x-pdf",
            path=asset.path,
        )
        with self.assertRaises(LiteratureArtifactReadError):
            with self.reader.open_artifact(altered):
                self.fail("a Catalog-mismatched Asset returned a stream")

    def test_asset_with_noncanonical_model_path_fails_before_returning_a_stream(self) -> None:
        payload = b"canonical asset bytes"
        reference = self._publish("canonical-asset-object", payload, "application/pdf")
        asset_id = AssetId(_ID_5)
        with self.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO assets(asset_id,sha256,size_bytes,media_type,relative_path) "
                "VALUES(?,?,?,?,?)",
                (
                    str(asset_id),
                    str(reference.sha256),
                    reference.byte_size,
                    reference.media_type,
                    str(reference.path),
                ),
            )
        noncanonical = Asset(
            asset_id=asset_id,
            sha256=reference.sha256,
            size_bytes=reference.byte_size,
            media_type=reference.media_type,
            path=RelativeArtifactPath("assets/not-content-addressed.pdf"),
        )

        with self.assertRaises(LiteratureArtifactReadError):
            self.reader.open_artifact(noncanonical)

    def test_tampered_file_and_context_exit_errors_are_stable_and_path_free(self) -> None:
        payload = b"immutable bytes"
        reference = self._publish("tamper-object", payload, "application/octet-stream")
        model_ref = ArtifactRef(
            sha256=reference.sha256,
            media_type=reference.media_type,
            byte_size=reference.byte_size,
        )
        target = self.root.canonical_path / str(reference.path)
        target.write_bytes(b"tampered before open")
        os.chmod(target, 0o600)

        with self.assertRaises(LiteratureArtifactReadError) as opening:
            with self.reader.open_artifact(model_ref):
                self.fail("tampered bytes returned a stream")
        self.assertEqual(str(opening.exception), "literature artifact read failed")
        self.assertNotIn(str(self.root.canonical_path), str(opening.exception))
        self.assertIsNone(opening.exception.__cause__)

        target.write_bytes(payload)
        os.chmod(target, 0o600)
        with self.assertRaises(LiteratureArtifactReadError) as closing:
            with self.reader.open_artifact(model_ref) as stream:
                self.assertEqual(stream.read(), payload)
                target.write_bytes(b"tampered during read")
                os.chmod(target, 0o600)
        self.assertEqual(str(closing.exception), "literature artifact read failed")
        self.assertNotIn(str(self.root.canonical_path), str(closing.exception))
        self.assertIsNone(closing.exception.__cause__)

    def test_caller_exception_is_not_reclassified_when_integrity_remains_valid(self) -> None:
        payload = b"valid bytes"
        reference = self._publish("caller-error-object", payload, "application/octet-stream")
        model_ref = ArtifactRef(
            sha256=reference.sha256,
            media_type=reference.media_type,
            byte_size=reference.byte_size,
        )
        marker = RuntimeError("caller owns this error")

        with self.assertRaises(RuntimeError) as caught:
            with self.reader.open_artifact(model_ref) as stream:
                self.assertEqual(stream.read(), payload)
                raise marker
        self.assertIs(caught.exception, marker)


if __name__ == "__main__":
    unittest.main()
