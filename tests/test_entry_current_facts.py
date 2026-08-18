from __future__ import annotations

import io
import sqlite3
import threading
import unittest
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal

from sciretriever.analysis.markdown import render_canonical_markdown
from sciretriever.entry.ports import (
    CurrentFactsSnapshotReadPort,
    LiteratureSelectorSnapshot,
    MetaSelectorSnapshot,
    ProviderRelationCandidatePage,
    ProviderRelationCandidateReadPort,
    ProviderRelationCandidateReadRequest,
    ProviderRelationCandidateRef,
    SelectorSnapshotReadPort,
)
from sciretriever.literature.content import (
    ContentAcceptanceReplacement,
    canonical_literature_content_json,
    literature_content_artifact,
    metadata_sha256,
)
from sciretriever.literature.ports import (
    ContentPublicationCommand,
    CurrentLiteratureFacts,
    IdentityObservationPublicationCommand,
    LiteratureIdentityToken,
    LiteratureObservation,
    MetaLiteratureIdentityToken,
)
from sciretriever.model.acquisition import (
    Asset,
    AssetHint,
    AssetHintKind,
    AssetRole,
    AutomaticPdfAcquisitionExhaustion,
    LiteratureAsset,
)
from sciretriever.model.analysis import (
    ArtifactRef,
    LiteratureContent,
    LiteratureSection,
    LiteratureSectionRole,
    analysis_input_sha256,
    content_sha256,
)
from sciretriever.model.discovery import (
    DiscoveryResult,
    DiscoveryRun,
    DiscoverySourceResult,
    ProviderDiscoveryLimit,
    TopicDiscoveryCause,
    TopicDiscoveryInput,
)
from sciretriever.model.execution import (
    AllPendingSelector,
    DiscoveryRunSelector,
    ImportReportSelector,
    LiteratureSelector,
    MetaLiteratureSelector,
    QuerySelector,
)
from sciretriever.model.library import LibraryQuery
from sciretriever.model.literature import (
    Identifier,
    Literature,
    LiteratureStatus,
    MetaLiterature,
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
    DiscoveryRunId,
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
from sciretriever.parsing.ports import (
    ParserResultPublicationCommand,
    StagedParserArtifact,
)
from sciretriever.storage.files.paths import StorageRoot
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactReference, ArtifactStore
from sciretriever.storage.sqlite.artifacts import register_artifact
from sciretriever.storage.sqlite.content_publication import SqliteContentPublication
from sciretriever.storage.sqlite.discovery_repository import SqliteDiscoveryRepository
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.entry_reader import (
    EntryReaderError,
    EntryReaderNotFoundError,
    SqliteEntryReader,
)
from sciretriever.storage.sqlite.literature_writer import LiteratureWriter
from sciretriever.storage.sqlite.parsing_publication import SqliteParserResultPublication

_TIMESTAMP = UtcTimestamp("2026-08-12T08:00:00Z")
_PARAMETERS_SHA256 = Sha256("f" * 64)


class _RepeatableBytes:
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


def _uuid(number: int) -> str:
    return f"00000000-0000-4000-8000-{number:012x}"


def _provenance(
    number: int,
    *,
    source_kind: SourceKind,
    source_name: str,
    source_record_id: str | None,
    input_sha256: Sha256 | None,
    parameters_sha256: Sha256 | None = None,
) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(_uuid(100_000 + number)),
        source_kind=source_kind,
        source_name=source_name,
        source_record_id=source_record_id,
        observed_at=_TIMESTAMP,
        input_sha256=input_sha256,
        parameters_sha256=parameters_sha256,
    )


def _metadata(
    number: int,
    *,
    title: str | None = None,
    identifiers: tuple[Identifier, ...] | None = None,
) -> LiteratureMetadata:
    return LiteratureMetadata(
        title=title or f"Entry current facts fixture {number}",
        publication_year=2020 + number % 6,
        document_type="journal-article",
        language="en",
        identifiers=(
            (Identifier(namespace="doi", value=f"10.1000/entry-{number}"),)
            if identifiers is None
            else identifiers
        ),
        keywords=("entry", "snapshot"),
    )


def _literature(
    number: int,
    *,
    meta_number: int | None = None,
    title: str | None = None,
    role: VersionRole = VersionRole.OTHER,
    identifiers: tuple[Identifier, ...] | None = None,
) -> Literature:
    return Literature(
        literature_id=LiteratureId(_uuid(number)),
        meta_literature_id=MetaLiteratureId(_uuid(number if meta_number is None else meta_number)),
        version_role=role,
        metadata=_metadata(number, title=title, identifiers=identifiers),
        status=LiteratureStatus.UNREVIEWED,
    )


def _observation(
    number: int,
    literature: Literature,
    *,
    source_name: str = "entry-fixture-provider",
    source_record_id: str | None = None,
) -> MetadataObservation:
    record_id = source_record_id or f"entry-record-{number}"
    return MetadataObservation(
        observation_id=ObservationId(_uuid(200_000 + number)),
        provenance=_provenance(
            1_000 + number,
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=source_name,
            source_record_id=record_id,
            input_sha256=sha256_digest(record_id.encode()),
        ),
        metadata=literature.metadata,
        version_role=literature.version_role,
    )


def _default_observation(literature: Literature) -> MetadataObservation:
    number = 700_000 + int(literature.literature_id.root[-12:], 16)
    return _observation(number, literature, source_name="entry-default-provider")


def _user_observation(number: int, literature: Literature) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_uuid(100_000 + number)),
        provenance=_provenance(
            80_000 + number,
            source_kind=SourceKind.USER,
            source_name="bibliographic-import",
            source_record_id=None,
            input_sha256=None,
        ),
        metadata=literature.metadata,
    )


def _relation(
    number: int,
    *,
    provider_name: str,
    citing: ProviderLiteratureKey,
    cited: ProviderLiteratureKey,
) -> ProviderRelationObservation:
    response_id = f"entry-relation-response-{number}"
    return ProviderRelationObservation(
        observation_id=ObservationId(_uuid(900_000 + number)),
        provenance=_provenance(
            90_000 + number,
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=provider_name,
            source_record_id=response_id,
            input_sha256=sha256_digest(response_id.encode()),
        ),
        citing=citing,
        cited=cited,
    )


class _PausingCatalogEngine(CatalogEngine):
    _pause: tuple[threading.Event, threading.Event] | None

    def __init__(self, catalog_path: Path) -> None:
        super().__init__(catalog_path, create=False)
        object.__setattr__(self, "_pause", None)

    def pause_next_snapshot(
        self,
        entered: threading.Event,
        release: threading.Event,
    ) -> None:
        object.__setattr__(self, "_pause", (entered, release))

    @contextmanager
    def read_snapshot(self) -> Generator[sqlite3.Connection, None, None]:
        with super().read_snapshot() as connection:
            pause = self._pause
            if pause is not None:
                object.__setattr__(self, "_pause", None)
                connection.execute("SELECT count(*) FROM literatures").fetchone()
                entered, release = pause
                entered.set()
                if not release.wait(timeout=10):
                    raise RuntimeError("timed out waiting to release Entry snapshot")
            yield connection


class EntryCurrentFactsReaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-entry-current-facts-")
        self.addCleanup(self.temporary.cleanup)
        temporary_path = Path(self.temporary.name)
        self.catalog_path = temporary_path / "catalog.sqlite"
        self.engine = CatalogEngine(self.catalog_path)
        self.writer = LiteratureWriter(self.engine)
        self.storage_root = StorageRoot(temporary_path / "artifacts")
        self.artifact_store = ArtifactStore(self.storage_root)
        self.verified_reader = VerifiedReader(self.storage_root)
        self.reader = SqliteEntryReader(self.engine, self.verified_reader)
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

    def _publish_literatures(
        self,
        literatures: tuple[Literature, ...],
        *,
        observations: tuple[LiteratureObservation, ...] = (),
    ) -> None:
        observation_values = list(observations)
        observed_literature_ids = {item.literature_id for item in observation_values}
        observation_values.extend(
            LiteratureObservation(
                literature_id=literature.literature_id,
                observation=_default_observation(literature),
            )
            for literature in literatures
            if literature.literature_id not in observed_literature_ids
        )
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
                        representative_literature_id=representative_id,
                    )
                    for meta_id, representative_id in representatives.items()
                ),
                observations=tuple(observation_values),
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
            )
        )

    def _publish_with_observations(
        self,
        literatures: tuple[Literature, ...],
    ) -> tuple[MetadataObservation, ...]:
        observations = tuple(
            _observation(number, literature)
            for number, literature in enumerate(literatures, start=1)
        )
        self._publish_literatures(
            literatures,
            observations=tuple(
                LiteratureObservation(
                    literature_id=literature.literature_id,
                    observation=observation,
                )
                for literature, observation in zip(literatures, observations, strict=True)
            ),
        )
        return observations

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
    def _identity_token(literature: Literature) -> LiteratureIdentityToken:
        return LiteratureIdentityToken(
            literature_id=literature.literature_id,
            meta_literature_id=literature.meta_literature_id,
            metadata_revision=1,
            metadata_sha256=metadata_sha256(literature.metadata),
        )

    def _publish_primary(self, literature: Literature, *, number: int) -> Asset:
        pdf = self._publish_artifact(
            f"%PDF-1.7\nentry-reader-{number}\n".encode(),
            media_type="application/pdf",
            artifact_id=f"entry-pdf-{number}",
        )
        asset = Asset(
            asset_id=AssetId(_uuid(300_000 + number)),
            sha256=pdf.sha256,
            size_bytes=pdf.byte_size,
            media_type=pdf.media_type,
            path=pdf.path,
        )
        self.writer.publish_asset(asset)
        self.writer.publish_literature_asset(
            LiteratureAsset(
                literature_asset_id=LiteratureAssetId(_uuid(310_000 + number)),
                literature_id=literature.literature_id,
                asset_id=asset.asset_id,
                role=AssetRole.PRIMARY_PDF,
                provenance=_provenance(
                    2_000 + number,
                    source_kind=SourceKind.ASSET_PROVIDER,
                    source_name="entry-fixture-assets",
                    source_record_id=f"asset-{number}",
                    input_sha256=asset.sha256,
                ),
            )
        )
        return asset

    def _publish_primary_and_parser(
        self,
        literature: Literature,
        *,
        number: int,
    ) -> tuple[Asset, ParserResult]:
        asset = self._publish_primary(literature, number=number)
        parser_bytes = f"# Entry parser fixture {number}\n".encode()
        parser_artifact = self._publish_artifact(
            parser_bytes,
            media_type="text/markdown",
            artifact_id=f"entry-parser-{number}",
        )
        markdown = ParserArtifactRef(
            sha256=parser_artifact.sha256,
            media_type=parser_artifact.media_type,
            byte_size=parser_artifact.byte_size,
        )
        provenance = ParserProvenance(
            provenance=_provenance(
                3_000 + number,
                source_kind=SourceKind.PARSER,
                source_name="entry-fixture-parser",
                source_record_id=None,
                input_sha256=asset.sha256,
                parameters_sha256=_PARAMETERS_SHA256,
            ),
            parser_version="1.0",
            mode="offline",
        )
        result = ParserResult(
            source_asset_id=asset.asset_id,
            source_sha256=asset.sha256,
            page_count=1,
            markdown=markdown,
            result_sha256=parser_result_sha256(
                source_asset_id=asset.asset_id,
                source_sha256=asset.sha256,
                page_count=1,
                markdown=markdown,
                resources=(),
                provenance=provenance,
            ),
            provenance=provenance,
        )
        self.parser_publication.publish_current(
            ParserResultPublicationCommand(
                result=result,
                markdown=StagedParserArtifact(
                    artifact=markdown,
                    content=_RepeatableBytes(parser_bytes),
                ),
                resources=(),
            )
        )
        return asset, result

    def _publish_complete_content(
        self,
        literature: Literature,
        *,
        number: int,
    ) -> tuple[Asset, ParserResult, LiteratureContent]:
        asset, parser_result = self._publish_primary_and_parser(
            literature,
            number=number,
        )
        sections = tuple(
            LiteratureSection(
                role=role,
                markdown=f"Entry reader body for {role.value} {number}.",
            )
            for role in (
                LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
                LiteratureSectionRole.METHODS,
                LiteratureSectionRole.DATA,
                LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
            )
        )
        references = ("Entry reference zero.", "Entry reference one.")
        markdown_bytes = render_canonical_markdown(
            metadata=literature.metadata,
            sections=sections,
            references=references,
        )
        markdown_artifact = self.artifact_store.publish(
            markdown_bytes,
            sha256=sha256_digest(markdown_bytes),
            byte_size=len(markdown_bytes),
            media_type="text/markdown",
        )
        digest = metadata_sha256(literature.metadata)
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
                sha256=markdown_artifact.sha256,
                media_type=markdown_artifact.media_type,
                byte_size=markdown_artifact.byte_size,
            ),
            provenance=_provenance(
                4_000 + number,
                source_kind=SourceKind.ANALYSIS,
                source_name="entry-fixture-analysis",
                source_record_id=None,
                input_sha256=analysis_input_sha256(
                    asset.sha256,
                    parser_result.result_sha256,
                    digest,
                ),
                parameters_sha256=_PARAMETERS_SHA256,
            ),
        )
        encoded = canonical_literature_content_json(content)
        self.content_publication.publish_content(
            ContentPublicationCommand(
                expected_token=self._identity_token(literature),
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
                structured_content=_RepeatableBytes(encoded),
            )
        )
        return asset, parser_result, content

    def _publish_topic_discovery(
        self,
        literature: Literature,
        observation: MetadataObservation,
        *,
        number: int,
    ) -> DiscoveryRunId:
        run_id = DiscoveryRunId(_uuid(400_000 + number))
        provider = ProviderDiscoveryLimit(provider_name="entry-fixture", scan_limit=20)
        repository = SqliteDiscoveryRepository(self.engine)
        repository.create(
            DiscoveryRun(
                discovery_run_id=run_id,
                input=TopicDiscoveryInput(
                    kind="topic",
                    query="entry current facts",
                    providers=(provider,),
                ),
                status="RUNNING",
                started_at=_TIMESTAMP,
            )
        )
        repository.publish_result_and_cause(
            DiscoveryResult(
                discovery_run_id=run_id,
                meta_literature_id=literature.meta_literature_id,
            ),
            TopicDiscoveryCause(
                kind="topic",
                discovery_run_id=run_id,
                meta_literature_id=literature.meta_literature_id,
                metadata_observation_id=observation.observation_id,
            ),
        )
        repository.publish_source_result(
            DiscoverySourceResult(
                discovery_run_id=run_id,
                provider_name=provider.provider_name,
                outcome="EXHAUSTED",
            )
        )
        repository.finalize(run_id, "COMPLETED")
        return run_id

    def _catalog_counts(self) -> dict[str, int]:
        tables = (
            "meta_literatures",
            "literatures",
            "literature_metadata",
            "metadata_observations",
            "metadata_observation_identifiers",
            "literature_metadata_observations",
            "provenances",
            "discovery_runs",
            "discovery_results",
            "provider_relation_observations",
            "provider_relation_endpoints",
            "provider_relation_endpoint_identifiers",
            "automatic_pdf_acquisition_exhaustions",
            "literature_assets",
            "parser_results",
            "literature_contents",
        )
        with self.engine.read_snapshot() as connection:
            return {
                table: int(connection.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0])
                for table in tables
            }

    def _read_relation_candidates(
        self,
        literature_ids: tuple[LiteratureId, ...],
        *,
        direction: Literal["references", "cited-by", "both"] = "both",
        provider_name: str,
        limit: int = 100,
        after_observation_id: ObservationId | None = None,
    ) -> ProviderRelationCandidatePage:
        return self.reader.read_provider_relation_candidates(
            ProviderRelationCandidateReadRequest(
                seed_literature_ids=literature_ids,
                direction=direction,
                provider_name=provider_name,
                limit=limit,
                after_observation_id=after_observation_id,
            )
        )

    def _raw_catalog_counts(self) -> dict[str, int]:
        connection = sqlite3.connect(self.catalog_path)
        try:
            table_names = tuple(
                str(row[0])
                for row in connection.execute(
                    "SELECT name FROM sqlite_schema WHERE type='table' "
                    "AND name NOT LIKE 'sqlite_%' ORDER BY name"
                ).fetchall()
            )
            return {
                table_name: int(
                    connection.execute(f'SELECT count(*) FROM "{table_name}"').fetchone()[0]
                )
                for table_name in table_names
            }
        finally:
            connection.close()

    def _publish_breakable_relation_fixture(
        self,
        number: int,
    ) -> tuple[Literature, MetadataObservation, ProviderRelationObservation, str]:
        provider_name = f"broken-provider-{number}"
        record_id = f"broken-record-{number}"
        seed = _literature(100 + number, meta_number=700 + number)
        seed_observation = _observation(
            100 + number,
            seed,
            source_name=provider_name,
            source_record_id=record_id,
        )
        self._publish_literatures(
            (seed,),
            observations=(
                LiteratureObservation(
                    literature_id=seed.literature_id,
                    observation=seed_observation,
                ),
            ),
        )
        relation = _relation(
            100 + number,
            provider_name=provider_name,
            citing=ProviderLiteratureKey(record_id=record_id),
            cited=ProviderLiteratureKey(record_id=f"broken-target-{number}"),
        )
        self.writer.publish_provider_relation_observations((relation,))
        return seed, seed_observation, relation, provider_name

    def _assert_broken_relation_read(
        self,
        seed: Literature,
        provider_name: str,
        before: dict[str, int],
    ) -> None:
        with self.assertRaises(EntryReaderError) as raised:
            self._read_relation_candidates(
                (seed.literature_id,),
                direction="references",
                provider_name=provider_name,
            )
        self.assertEqual(str(raised.exception), "entry current facts read failed")
        self.assertNotIn(seed.literature_id.root, str(raised.exception))
        self.assertNotIn(str(self.catalog_path), str(raised.exception))
        self.assertEqual(self._raw_catalog_counts(), before)

    def test_adapter_implements_all_entry_read_ports(self) -> None:
        self.assertIsInstance(self.reader, SelectorSnapshotReadPort)
        self.assertIsInstance(self.reader, CurrentFactsSnapshotReadPort)
        self.assertIsInstance(self.reader, ProviderRelationCandidateReadPort)

    def test_six_selectors_expand_exact_scope_and_all_meta_members(self) -> None:
        published = _literature(
            1,
            meta_number=100,
            title="Selected query version",
            role=VersionRole.PUBLISHED,
        )
        preprint = _literature(
            2,
            meta_number=100,
            title="Sibling not matching the query",
            role=VersionRole.PREPRINT,
        )
        discovered = _literature(
            3,
            meta_number=200,
            title="Selected query discovery",
            role=VersionRole.OTHER,
        )
        unrelated = _literature(4, meta_number=300, title="Unrelated fixture")
        literatures = (published, preprint, discovered, unrelated)
        observations = self._publish_with_observations(literatures)
        discovery_run_id = self._publish_topic_discovery(
            discovered,
            observations[2],
            number=1,
        )

        all_snapshot = self.reader.read_selector(AllPendingSelector(kind="all-pending"))
        self.assertIsInstance(all_snapshot, MetaSelectorSnapshot)
        assert isinstance(all_snapshot, MetaSelectorSnapshot)
        self.assertEqual(
            all_snapshot.meta_literature_ids,
            tuple(sorted({item.meta_literature_id for item in literatures}, key=str)),
        )
        self.assertEqual(
            {item.current.literature.literature_id for item in all_snapshot.current_facts},
            {item.literature_id for item in literatures},
        )

        discovery_snapshot = self.reader.read_selector(
            DiscoveryRunSelector(
                kind="discovery-run",
                discovery_run_id=discovery_run_id,
            )
        )
        self.assertIsInstance(discovery_snapshot, MetaSelectorSnapshot)
        assert isinstance(discovery_snapshot, MetaSelectorSnapshot)
        self.assertEqual(
            discovery_snapshot.meta_literature_ids,
            (discovered.meta_literature_id,),
        )
        self.assertEqual(
            tuple(
                item.current.literature.literature_id for item in discovery_snapshot.current_facts
            ),
            (discovered.literature_id,),
        )

        explicit_order = (discovered.meta_literature_id, published.meta_literature_id)
        for selector in (
            ImportReportSelector(
                kind="import-report",
                meta_literature_ids=explicit_order,
            ),
            MetaLiteratureSelector(
                kind="meta-literatures",
                meta_literature_ids=explicit_order,
            ),
        ):
            with self.subTest(kind=selector.kind):
                snapshot = self.reader.read_selector(selector)
                self.assertIsInstance(snapshot, MetaSelectorSnapshot)
                assert isinstance(snapshot, MetaSelectorSnapshot)
                self.assertEqual(snapshot.meta_literature_ids, explicit_order)
                self.assertEqual(
                    {item.current.literature.literature_id for item in snapshot.current_facts},
                    {published.literature_id, preprint.literature_id, discovered.literature_id},
                )
                meta_by_id = {item.meta_literature_id: item for item in snapshot.meta_literatures}
                self.assertEqual(
                    meta_by_id[published.meta_literature_id].representative_literature_id,
                    published.literature_id,
                )

        query_snapshot = self.reader.read_selector(
            QuerySelector(
                kind="query",
                query=LibraryQuery(title="Selected query"),
            )
        )
        self.assertIsInstance(query_snapshot, MetaSelectorSnapshot)
        assert isinstance(query_snapshot, MetaSelectorSnapshot)
        self.assertEqual(
            query_snapshot.meta_literature_ids,
            (published.meta_literature_id, discovered.meta_literature_id),
        )
        self.assertEqual(
            {item.current.literature.literature_id for item in query_snapshot.current_facts},
            {published.literature_id, preprint.literature_id, discovered.literature_id},
        )

        literature_snapshot = self.reader.read_selector(
            LiteratureSelector(
                kind="literatures",
                literature_ids=(discovered.literature_id, published.literature_id),
            )
        )
        self.assertIsInstance(literature_snapshot, LiteratureSelectorSnapshot)
        assert isinstance(literature_snapshot, LiteratureSelectorSnapshot)
        self.assertEqual(
            literature_snapshot.literature_ids,
            (discovered.literature_id, published.literature_id),
        )
        self.assertEqual(
            tuple(
                item.current.literature.literature_id for item in literature_snapshot.current_facts
            ),
            (discovered.literature_id, published.literature_id),
        )

    def test_query_selector_reads_the_complete_match_set_not_a_default_page(self) -> None:
        literatures = tuple(
            _literature(
                1_000 + number,
                meta_number=2_000 + number,
                title=f"Complete selector result {number:02d}",
            )
            for number in range(55)
        )
        self._publish_literatures(literatures)

        snapshot = self.reader.read_selector(
            QuerySelector(
                kind="query",
                query=LibraryQuery(title="Complete selector result"),
            )
        )

        self.assertIsInstance(snapshot, MetaSelectorSnapshot)
        assert isinstance(snapshot, MetaSelectorSnapshot)
        self.assertEqual(len(snapshot.meta_literature_ids), 55)
        self.assertEqual(len(snapshot.meta_literatures), 55)
        self.assertEqual(len(snapshot.current_facts), 55)
        self.assertEqual(
            {item.current.literature.literature_id for item in snapshot.current_facts},
            {item.literature_id for item in literatures},
        )

    def test_current_facts_rebuild_metadata_pdf_parser_content_and_exhaustion(self) -> None:
        complete = _literature(
            10,
            meta_number=500,
            title="Complete current facts",
            role=VersionRole.PUBLISHED,
        )
        exhausted = _literature(
            11,
            meta_number=500,
            title="Exhausted sibling",
            role=VersionRole.PREPRINT,
        )
        self._publish_literatures((complete, exhausted))
        asset, parser_result, content = self._publish_complete_content(complete, number=10)
        self.writer.publish_exhaustion(
            AutomaticPdfAcquisitionExhaustion(literature_id=exhausted.literature_id)
        )

        snapshot = self.reader.read_selector(
            MetaLiteratureSelector(
                kind="meta-literatures",
                meta_literature_ids=(complete.meta_literature_id,),
            )
        )
        self.assertIsInstance(snapshot, MetaSelectorSnapshot)
        assert isinstance(snapshot, MetaSelectorSnapshot)
        by_id = {item.current.literature.literature_id: item for item in snapshot.current_facts}
        complete_facts = by_id[complete.literature_id]
        self.assertEqual(complete_facts.current.metadata_revision, 1)
        self.assertEqual(
            complete_facts.current.metadata_sha256,
            metadata_sha256(complete.metadata),
        )
        self.assertEqual(
            complete_facts.current.current_primary_pdfs[0].asset,
            asset,
        )
        self.assertEqual(complete_facts.current.current_parser_result, parser_result)
        self.assertEqual(complete_facts.current.current_content, content)
        self.assertEqual(
            complete_facts.current.current_content_lineage.parser_result_sha256,
            parser_result.result_sha256,
        )
        self.assertIsNone(complete_facts.automatic_pdf_exhaustion)
        self.assertEqual(
            by_id[exhausted.literature_id].automatic_pdf_exhaustion,
            AutomaticPdfAcquisitionExhaustion(literature_id=exhausted.literature_id),
        )

        reread = self.reader.read_current(complete.literature_id)
        self.assertEqual(reread.literature_id, complete.literature_id)
        self.assertEqual(reread.current_facts, (complete_facts,))

    def test_current_facts_rebuild_complete_ordered_observation_closure(self) -> None:
        literature = _literature(12, meta_number=501)
        later = _observation(12, literature).model_copy(
            update={
                "reference_texts": ("First retained reference.", "Second retained reference."),
                "asset_hints": (
                    AssetHint(
                        url="https://content.example.test/paper.pdf",
                        kind=AssetHintKind.DIRECT_FILE,
                        media_type="application/pdf",
                        asset_role=AssetRole.PRIMARY_PDF,
                    ),
                    AssetHint(
                        url="https://content.example.test/article",
                        kind=AssetHintKind.LANDING_PAGE,
                    ),
                ),
            }
        )
        earlier = _user_observation(12, literature)
        self.assertLess(earlier.observation_id.root, later.observation_id.root)
        self._publish_literatures(
            (literature,),
            observations=(
                LiteratureObservation(
                    literature_id=literature.literature_id,
                    observation=later,
                ),
                LiteratureObservation(
                    literature_id=literature.literature_id,
                    observation=earlier,
                ),
            ),
        )

        selected = self.reader.read_selector(
            LiteratureSelector(
                kind="literatures",
                literature_ids=(literature.literature_id,),
            )
        )
        reread = self.reader.read_current(literature.literature_id)

        self.assertIsInstance(selected, LiteratureSelectorSnapshot)
        assert isinstance(selected, LiteratureSelectorSnapshot)
        self.assertEqual(
            selected.current_facts[0].metadata_observations,
            (earlier, later),
        )
        self.assertEqual(reread.current_facts, selected.current_facts)
        self.assertEqual(
            selected.current_facts[0].metadata_observations[1].asset_hints,
            later.asset_hints,
        )
        self.assertEqual(
            selected.current_facts[0].metadata_observations[1].reference_texts,
            later.reference_texts,
        )

    def test_current_facts_missing_observation_ownership_fails_closed(self) -> None:
        literature = _literature(13, meta_number=502)
        observation = _observation(13, literature)
        self._publish_literatures(
            (literature,),
            observations=(
                LiteratureObservation(
                    literature_id=literature.literature_id,
                    observation=observation,
                ),
            ),
        )
        with self.engine.write_transaction() as connection:
            connection.execute(
                "DELETE FROM literature_metadata_observations WHERE literature_id=?",
                (literature.literature_id.root,),
            )
        before = self._raw_catalog_counts()

        with self.assertRaises(EntryReaderError) as raised:
            self.reader.read_current(literature.literature_id)

        self.assertEqual(str(raised.exception), "entry current facts read failed")
        self.assertNotIn(literature.literature_id.root, str(raised.exception))
        self.assertEqual(self._raw_catalog_counts(), before)

    def test_unknown_current_is_an_empty_exact_hit_and_explicit_scopes_fail_closed(self) -> None:
        unknown_literature_id = LiteratureId(_uuid(900_001))
        unknown_meta_id = MetaLiteratureId(_uuid(900_002))
        unknown_run_id = DiscoveryRunId(_uuid(900_003))

        current = self.reader.read_current(unknown_literature_id)
        self.assertEqual(current.literature_id, unknown_literature_id)
        self.assertEqual(current.current_facts, ())

        selectors = (
            LiteratureSelector(
                kind="literatures",
                literature_ids=(unknown_literature_id,),
            ),
            MetaLiteratureSelector(
                kind="meta-literatures",
                meta_literature_ids=(unknown_meta_id,),
            ),
            DiscoveryRunSelector(
                kind="discovery-run",
                discovery_run_id=unknown_run_id,
            ),
        )
        before = self._catalog_counts()
        for selector in selectors:
            with self.subTest(kind=selector.kind):
                with self.assertRaises(EntryReaderNotFoundError) as raised:
                    self.reader.read_selector(selector)
                self.assertEqual(str(raised.exception), "entry selector object was not found")
                self.assertNotIn("90000", str(raised.exception))
                self.assertNotIn(str(self.catalog_path), str(raised.exception))
        self.assertEqual(self._catalog_counts(), before)

    def test_provider_record_candidates_are_scoped_to_the_same_provider(self) -> None:
        seed = _literature(20, meta_number=600)
        seed_observation = _observation(
            20,
            seed,
            source_name="record-provider",
            source_record_id="shared-provider-record",
        )
        earlier_observation = _observation(
            19,
            seed,
            source_name="earlier-seed-provider",
            source_record_id="earlier-provider-record",
        )
        self._publish_literatures(
            (seed,),
            observations=(
                LiteratureObservation(
                    literature_id=seed.literature_id,
                    observation=earlier_observation,
                ),
                LiteratureObservation(
                    literature_id=seed.literature_id,
                    observation=seed_observation,
                ),
            ),
        )
        same_provider = _relation(
            1,
            provider_name="record-provider",
            citing=ProviderLiteratureKey(record_id="shared-provider-record"),
            cited=ProviderLiteratureKey(record_id="same-provider-target"),
        )
        different_provider = _relation(
            2,
            provider_name="different-provider",
            citing=ProviderLiteratureKey(record_id="shared-provider-record"),
            cited=ProviderLiteratureKey(record_id="different-provider-target"),
        )
        self.writer.publish_provider_relation_observations((same_provider, different_provider))
        before = self._catalog_counts()

        same_page = self._read_relation_candidates(
            (seed.literature_id,),
            direction="references",
            provider_name="record-provider",
        )
        different_page = self._read_relation_candidates(
            (seed.literature_id,),
            direction="references",
            provider_name="different-provider",
        )

        self.assertEqual(
            same_page.seed_facts[0].metadata_observations,
            (earlier_observation, seed_observation),
        )
        self.assertEqual(
            same_page.candidates,
            (
                ProviderRelationCandidateRef(
                    observation_id=same_provider.observation_id,
                    seed_endpoint="citing",
                    candidate_seed_literature_ids=(seed.literature_id,),
                ),
            ),
        )
        self.assertEqual(different_page.candidates, ())
        self.assertIsNone(same_page.next_after_observation_id)
        self.assertEqual(self._catalog_counts(), before)

    def test_identifier_prefilter_is_exact_and_returns_all_seeds_in_request_order(
        self,
    ) -> None:
        shared_identifier = Identifier(namespace="vendor-key", value="Exact-Key")
        first = _literature(
            21,
            meta_number=601,
            identifiers=(
                Identifier(namespace="doi", value="10.1000/identifier-first"),
                shared_identifier,
            ),
        )
        second = _literature(
            22,
            meta_number=602,
            identifiers=(
                Identifier(namespace="doi", value="10.1000/identifier-second"),
                shared_identifier,
            ),
        )
        first_observation = _observation(21, first, source_name="seed-provider")
        second_observation = _observation(22, second, source_name="seed-provider")
        self._publish_literatures(
            (first, second),
            observations=(
                LiteratureObservation(
                    literature_id=first.literature_id,
                    observation=first_observation,
                ),
                LiteratureObservation(
                    literature_id=second.literature_id,
                    observation=second_observation,
                ),
            ),
        )
        exact = _relation(
            3,
            provider_name="relation-provider",
            citing=ProviderLiteratureKey(identifiers=(shared_identifier,)),
            cited=ProviderLiteratureKey(record_id="identifier-target"),
        )
        case_mismatch = _relation(
            4,
            provider_name="relation-provider",
            citing=ProviderLiteratureKey(
                identifiers=(Identifier(namespace="vendor-key", value="exact-key"),)
            ),
            cited=ProviderLiteratureKey(record_id="case-mismatch-target"),
        )
        self.writer.publish_provider_relation_observations((exact, case_mismatch))

        page = self._read_relation_candidates(
            (second.literature_id, first.literature_id),
            direction="references",
            provider_name="relation-provider",
        )

        self.assertEqual(
            page.candidates,
            (
                ProviderRelationCandidateRef(
                    observation_id=exact.observation_id,
                    seed_endpoint="citing",
                    candidate_seed_literature_ids=(
                        second.literature_id,
                        first.literature_id,
                    ),
                ),
            ),
        )

    def test_references_cited_by_and_both_select_the_closed_seed_endpoints(self) -> None:
        citing_seed = _literature(23, meta_number=603)
        cited_seed = _literature(24, meta_number=604)
        citing_observation = _observation(
            23,
            citing_seed,
            source_name="direction-provider",
            source_record_id="direction-citing",
        )
        cited_observation = _observation(
            24,
            cited_seed,
            source_name="direction-provider",
            source_record_id="direction-cited",
        )
        self._publish_literatures(
            (citing_seed, cited_seed),
            observations=(
                LiteratureObservation(
                    literature_id=citing_seed.literature_id,
                    observation=citing_observation,
                ),
                LiteratureObservation(
                    literature_id=cited_seed.literature_id,
                    observation=cited_observation,
                ),
            ),
        )
        relation = _relation(
            5,
            provider_name="direction-provider",
            citing=ProviderLiteratureKey(record_id="direction-citing"),
            cited=ProviderLiteratureKey(record_id="direction-cited"),
        )
        self.writer.publish_provider_relation_observations((relation,))
        seeds = (cited_seed.literature_id, citing_seed.literature_id)

        references = self._read_relation_candidates(
            seeds,
            direction="references",
            provider_name="direction-provider",
        )
        cited_by = self._read_relation_candidates(
            seeds,
            direction="cited-by",
            provider_name="direction-provider",
        )
        both = self._read_relation_candidates(
            seeds,
            direction="both",
            provider_name="direction-provider",
        )

        citing_ref = ProviderRelationCandidateRef(
            observation_id=relation.observation_id,
            seed_endpoint="citing",
            candidate_seed_literature_ids=(citing_seed.literature_id,),
        )
        cited_ref = ProviderRelationCandidateRef(
            observation_id=relation.observation_id,
            seed_endpoint="cited",
            candidate_seed_literature_ids=(cited_seed.literature_id,),
        )
        self.assertEqual(references.candidates, (citing_ref,))
        self.assertEqual(cited_by.candidates, (cited_ref,))
        self.assertEqual(both.candidates, (citing_ref, cited_ref))
        self.assertEqual(
            tuple(item.literature_id for item in both.seed_facts),
            seeds,
        )

    def test_relation_scan_paginates_scanned_rows_and_advances_empty_candidate_pages(
        self,
    ) -> None:
        seed = _literature(25, meta_number=605)
        seed_observation = _observation(
            25,
            seed,
            source_name="page-provider",
            source_record_id="page-seed",
        )
        self._publish_literatures(
            (seed,),
            observations=(
                LiteratureObservation(
                    literature_id=seed.literature_id,
                    observation=seed_observation,
                ),
            ),
        )
        first_miss = _relation(
            10,
            provider_name="page-provider",
            citing=ProviderLiteratureKey(record_id="first-miss"),
            cited=ProviderLiteratureKey(record_id="first-target"),
        )
        filtered_other_provider = _relation(
            11,
            provider_name="other-page-provider",
            citing=ProviderLiteratureKey(record_id="page-seed"),
            cited=ProviderLiteratureKey(record_id="filtered-target"),
        )
        middle_hit = _relation(
            12,
            provider_name="page-provider",
            citing=ProviderLiteratureKey(record_id="page-seed"),
            cited=ProviderLiteratureKey(record_id="middle-target"),
        )
        last_miss = _relation(
            13,
            provider_name="page-provider",
            citing=ProviderLiteratureKey(record_id="last-miss"),
            cited=ProviderLiteratureKey(record_id="last-target"),
        )
        self.writer.publish_provider_relation_observations(
            (
                first_miss,
                filtered_other_provider,
                middle_hit,
                last_miss,
            )
        )
        before = self._catalog_counts()

        first_page = self._read_relation_candidates(
            (seed.literature_id,),
            direction="references",
            provider_name="page-provider",
            limit=1,
        )
        second_page = self._read_relation_candidates(
            (seed.literature_id,),
            direction="references",
            provider_name="page-provider",
            limit=1,
            after_observation_id=first_page.next_after_observation_id,
        )
        third_page = self._read_relation_candidates(
            (seed.literature_id,),
            direction="references",
            provider_name="page-provider",
            limit=1,
            after_observation_id=second_page.next_after_observation_id,
        )

        self.assertEqual(first_page.candidates, ())
        self.assertEqual(first_page.next_after_observation_id, first_miss.observation_id)
        self.assertEqual(
            second_page.candidates,
            (
                ProviderRelationCandidateRef(
                    observation_id=middle_hit.observation_id,
                    seed_endpoint="citing",
                    candidate_seed_literature_ids=(seed.literature_id,),
                ),
            ),
        )
        self.assertEqual(second_page.next_after_observation_id, middle_hit.observation_id)
        self.assertEqual(third_page.candidates, ())
        self.assertIsNone(third_page.next_after_observation_id)
        self.assertEqual(
            tuple(
                candidate.observation_id
                for page in (first_page, second_page, third_page)
                for candidate in page.candidates
            ),
            (middle_hit.observation_id,),
        )
        self.assertEqual(self._catalog_counts(), before)

    def test_unknown_relation_seed_fails_closed_without_writes(self) -> None:
        unknown = LiteratureId(_uuid(999_100))
        before = self._catalog_counts()

        with self.assertRaises(EntryReaderNotFoundError) as raised:
            self._read_relation_candidates(
                (unknown,),
                provider_name="unknown-seed-provider",
            )

        self.assertEqual(str(raised.exception), "entry selector object was not found")
        self.assertNotIn(unknown.root, str(raised.exception))
        self.assertNotIn(str(self.catalog_path), str(raised.exception))
        self.assertEqual(self._catalog_counts(), before)

    def test_current_observation_ownership_survives_meta_identity_merge(self) -> None:
        moved = _literature(26, meta_number=606)
        existing = _literature(27, meta_number=607)
        moved_observation = _observation(
            26,
            moved,
            source_name="merge-provider",
            source_record_id="moved-record",
        )
        existing_observation = _observation(
            27,
            existing,
            source_name="merge-provider",
            source_record_id="existing-record",
        )
        self._publish_literatures(
            (moved, existing),
            observations=(
                LiteratureObservation(
                    literature_id=moved.literature_id,
                    observation=moved_observation,
                ),
                LiteratureObservation(
                    literature_id=existing.literature_id,
                    observation=existing_observation,
                ),
            ),
        )
        moved_after_merge = moved.model_copy(
            update={"meta_literature_id": existing.meta_literature_id}
        )
        self.writer.publish_identity_and_observation(
            IdentityObservationPublicationCommand(
                literatures=(moved_after_merge, existing),
                meta_literatures=(
                    MetaLiterature(
                        meta_literature_id=existing.meta_literature_id,
                        representative_literature_id=existing.literature_id,
                    ),
                ),
                observations=(),
                facts=(
                    CurrentLiteratureFacts(
                        literature=moved_after_merge,
                        metadata_revision=1,
                        metadata_sha256=metadata_sha256(moved.metadata),
                    ),
                    CurrentLiteratureFacts(
                        literature=existing,
                        metadata_revision=1,
                        metadata_sha256=metadata_sha256(existing.metadata),
                    ),
                ),
                expected_tokens=(
                    self._identity_token(moved),
                    self._identity_token(existing),
                ),
                expected_meta_tokens=(
                    MetaLiteratureIdentityToken(
                        meta_literature_id=moved.meta_literature_id,
                        representative_literature_id=moved.literature_id,
                        member_literature_ids=(moved.literature_id,),
                    ),
                    MetaLiteratureIdentityToken(
                        meta_literature_id=existing.meta_literature_id,
                        representative_literature_id=existing.literature_id,
                        member_literature_ids=(existing.literature_id,),
                    ),
                ),
                retired_meta_literature_ids=(moved.meta_literature_id,),
            )
        )
        relation = _relation(
            14,
            provider_name="merge-provider",
            citing=ProviderLiteratureKey(record_id="moved-record"),
            cited=ProviderLiteratureKey(record_id="merge-target"),
        )
        self.writer.publish_provider_relation_observations((relation,))

        page = self._read_relation_candidates(
            (moved.literature_id,),
            direction="references",
            provider_name="merge-provider",
        )

        self.assertEqual(
            page.seed_facts[0].metadata_observations,
            (moved_observation,),
        )
        self.assertEqual(
            page.candidates[0].candidate_seed_literature_ids,
            (moved.literature_id,),
        )

    def test_missing_seed_observation_ownership_row_fails_closed(self) -> None:
        seed, seed_observation, relation, provider_name = self._publish_breakable_relation_fixture(
            4
        )
        with self.engine.write_transaction() as connection:
            cursor = connection.execute(
                "DELETE FROM literature_metadata_observations "
                "WHERE literature_id=? AND observation_id=?",
                (seed.literature_id.root, seed_observation.observation_id.root),
            )
            self.assertEqual(cursor.rowcount, 1)
        before = self._raw_catalog_counts()
        self.assertEqual(before["literatures"], 1)
        self.assertEqual(before["metadata_observations"], 1)
        self.assertEqual(before["provider_relation_observations"], 1)
        self.assertEqual(before["literature_metadata_observations"], 0)
        self.assertEqual(relation.provenance.source_name, provider_name)

        self._assert_broken_relation_read(seed, provider_name, before)

    def test_broken_seed_observation_ownership_fails_closed(self) -> None:
        seed, seed_observation, _, provider_name = self._publish_breakable_relation_fixture(1)
        connection = sqlite3.connect(self.catalog_path)
        try:
            connection.execute("PRAGMA foreign_keys=OFF")
            connection.execute(
                "DELETE FROM metadata_observations WHERE observation_id=?",
                (seed_observation.observation_id.root,),
            )
            connection.commit()
        finally:
            connection.close()
        before = self._raw_catalog_counts()

        self._assert_broken_relation_read(seed, provider_name, before)

    def test_broken_relation_endpoint_fails_closed(self) -> None:
        seed, _, relation, provider_name = self._publish_breakable_relation_fixture(2)
        with self.engine.write_transaction() as connection:
            connection.execute(
                "DELETE FROM provider_relation_endpoints "
                "WHERE observation_id=? AND endpoint_kind='cited'",
                (relation.observation_id.root,),
            )
        before = self._raw_catalog_counts()

        self._assert_broken_relation_read(seed, provider_name, before)

    def test_broken_relation_provenance_fails_closed(self) -> None:
        seed, _, relation, provider_name = self._publish_breakable_relation_fixture(3)
        connection = sqlite3.connect(self.catalog_path)
        try:
            connection.execute("PRAGMA foreign_keys=OFF")
            connection.execute(
                "DELETE FROM provenances WHERE provenance_id=?",
                (relation.provenance.provenance_id.root,),
            )
            connection.commit()
        finally:
            connection.close()
        before = self._raw_catalog_counts()

        self._assert_broken_relation_read(seed, provider_name, before)

    def test_one_read_snapshot_does_not_mix_a_concurrent_committed_member(self) -> None:
        first = _literature(30, meta_number=700)
        self._publish_literatures((first,))
        pausing_engine = _PausingCatalogEngine(self.catalog_path)
        reader = SqliteEntryReader(pausing_engine, self.verified_reader)
        entered = threading.Event()
        release = threading.Event()
        pausing_engine.pause_next_snapshot(entered, release)
        results: list[MetaSelectorSnapshot] = []
        failures: list[BaseException] = []

        def read() -> None:
            try:
                snapshot = reader.read_selector(AllPendingSelector(kind="all-pending"))
                if not isinstance(snapshot, MetaSelectorSnapshot):
                    raise AssertionError("expected a MetaSelectorSnapshot")
                results.append(snapshot)
            except BaseException as error:  # pragma: no cover - asserted below.
                failures.append(error)

        thread = threading.Thread(target=read)
        thread.start()
        self.assertTrue(entered.wait(timeout=10))
        later = _literature(31, meta_number=701)
        self._publish_literatures((later,))
        release.set()
        thread.join(timeout=10)

        self.assertFalse(thread.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].meta_literature_ids, (first.meta_literature_id,))
        self.assertEqual(
            tuple(item.current.literature.literature_id for item in results[0].current_facts),
            (first.literature_id,),
        )

    def test_relation_candidate_read_uses_one_snapshot_during_concurrent_publication(
        self,
    ) -> None:
        seed = _literature(32, meta_number=702)
        seed_observation = _observation(
            32,
            seed,
            source_name="snapshot-provider",
            source_record_id="snapshot-seed",
        )
        self._publish_literatures(
            (seed,),
            observations=(
                LiteratureObservation(
                    literature_id=seed.literature_id,
                    observation=seed_observation,
                ),
            ),
        )
        first_relation = _relation(
            200,
            provider_name="snapshot-provider",
            citing=ProviderLiteratureKey(record_id="snapshot-seed"),
            cited=ProviderLiteratureKey(record_id="snapshot-first-target"),
        )
        self.writer.publish_provider_relation_observations((first_relation,))
        pausing_engine = _PausingCatalogEngine(self.catalog_path)
        reader = SqliteEntryReader(pausing_engine, self.verified_reader)
        entered = threading.Event()
        release = threading.Event()
        pausing_engine.pause_next_snapshot(entered, release)
        results: list[ProviderRelationCandidatePage] = []
        failures: list[BaseException] = []

        def read() -> None:
            try:
                results.append(
                    reader.read_provider_relation_candidates(
                        ProviderRelationCandidateReadRequest(
                            seed_literature_ids=(seed.literature_id,),
                            direction="references",
                            provider_name="snapshot-provider",
                            limit=10,
                        )
                    )
                )
            except BaseException as error:  # pragma: no cover - asserted below.
                failures.append(error)

        thread = threading.Thread(target=read)
        thread.start()
        self.assertTrue(entered.wait(timeout=10))
        later_relation = _relation(
            201,
            provider_name="snapshot-provider",
            citing=ProviderLiteratureKey(record_id="snapshot-seed"),
            cited=ProviderLiteratureKey(record_id="snapshot-later-target"),
        )
        self.writer.publish_provider_relation_observations((later_relation,))
        release.set()
        thread.join(timeout=10)

        self.assertFalse(thread.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(len(results), 1)
        self.assertEqual(
            tuple(candidate.observation_id for candidate in results[0].candidates),
            (first_relation.observation_id,),
        )
        self.assertNotIn(
            later_relation.observation_id,
            {candidate.observation_id for candidate in results[0].candidates},
        )

    def test_broken_representative_fails_with_one_redacted_error_and_no_read_write(self) -> None:
        literature = _literature(40, meta_number=800)
        self._publish_literatures((literature,))
        connection = sqlite3.connect(self.catalog_path)
        try:
            connection.execute("PRAGMA foreign_keys=OFF")
            connection.execute(
                "UPDATE meta_literatures SET representative_literature_id=? "
                "WHERE meta_literature_id=?",
                (_uuid(999_999), literature.meta_literature_id.root),
            )
            connection.commit()
        finally:
            connection.close()

        with self.assertRaises(EntryReaderError) as raised:
            self.reader.read_selector(AllPendingSelector(kind="all-pending"))

        self.assertEqual(str(raised.exception), "entry current facts read failed")
        self.assertNotIn(_uuid(999_999), str(raised.exception))
        self.assertNotIn(str(self.catalog_path), str(raised.exception))

    def test_cross_literature_content_asset_and_mixed_metadata_hash_fail_closed(self) -> None:
        first = _literature(50, meta_number=900)
        second = _literature(51, meta_number=901)
        self._publish_literatures((first, second))
        self._publish_complete_content(first, number=50)
        second_asset = self._publish_primary(second, number=51)
        before = self._catalog_counts()
        with self.engine.write_transaction() as connection:
            connection.execute(
                "UPDATE literature_contents SET primary_asset_id=?,primary_asset_sha256=? "
                "WHERE literature_id=?",
                (second_asset.asset_id.root, second_asset.sha256.root, first.literature_id.root),
            )

        with self.assertRaises(EntryReaderError) as cross_error:
            self.reader.read_current(first.literature_id)
        self.assertEqual(str(cross_error.exception), "entry current facts read failed")
        self.assertEqual(self._catalog_counts(), before)

        mixed = _literature(52, meta_number=902)
        self._publish_literatures((mixed,))
        wrong_hash = Sha256("b" * 64)
        with self.engine.write_transaction() as connection:
            connection.execute(
                "UPDATE literature_metadata SET metadata_sha256=? WHERE literature_id=?",
                (wrong_hash.root, mixed.literature_id.root),
            )
        before_mixed_read = self._catalog_counts()

        with self.assertRaises(EntryReaderError) as mixed_error:
            self.reader.read_current(mixed.literature_id)
        self.assertEqual(str(mixed_error.exception), "entry current facts read failed")
        self.assertEqual(self._catalog_counts(), before_mixed_read)


if __name__ == "__main__":
    unittest.main()
