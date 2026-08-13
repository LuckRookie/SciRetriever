from __future__ import annotations

import io
import sqlite3
import threading
import unittest
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast

import sciretriever.storage.sqlite.literature_reader as literature_reader_module
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
    LiteratureObservation,
    MetaLiteratureReadRequest,
    ProviderRelationObservationReadRequest,
    ReferencePublicationCommand,
)
from sciretriever.literature.query import LiteratureCursorError
from sciretriever.literature.state import CurrentLiteratureFacts
from sciretriever.model.acquisition import (
    Asset,
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
from sciretriever.model.library import (
    LibraryQuery,
    LibrarySearchPage,
    LibrarySearchRequest,
    LibrarySort,
    LiteratureReferenceRequest,
)
from sciretriever.model.literature import (
    Affiliation,
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
    DiscoveryRunId,
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
from sciretriever.storage.files.paths import StorageRoot
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactReference, ArtifactStore
from sciretriever.storage.sqlite.artifacts import register_artifact
from sciretriever.storage.sqlite.content_publication import SqliteContentPublication
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.literature_reader import (
    LiteratureReader,
    LiteratureReaderError,
    LiteratureReaderNotFoundError,
)
from sciretriever.storage.sqlite.literature_writer import LiteratureWriter
from sciretriever.storage.sqlite.parsing_publication import SqliteParserResultPublication

_TIMESTAMP = UtcTimestamp("2026-08-11T08:00:00Z")
_PARAMETERS_SHA256 = Sha256("f" * 64)
_ORCID = "0000-0002-1825-0097"


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

    def __repr__(self) -> str:
        return "<_RepeatableBytes>"


def _uuid(number: int) -> str:
    return f"00000000-0000-4000-8000-{number:012x}"


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


def _metadata(
    number: int,
    *,
    title: str | None = None,
    year: int | None = 2024,
    document_type: str = "journal-article",
    language: str = "en",
    venue: str = "Journal of Graph Retrieval",
    publisher: str = "École Press",
    keywords: tuple[str, ...] = ("graph", "retrieval"),
    identifiers: tuple[Identifier, ...] | None = None,
) -> LiteratureMetadata:
    actual_identifiers = identifiers
    if actual_identifiers is None:
        actual_identifiers = (Identifier(namespace="doi", value=f"10.1000/{number}"),)
    return LiteratureMetadata(
        title=title if title is not None else f"Graph Retrieval Study {number}",
        authors=(
            Author(
                kind=AuthorKind.PERSON,
                display_name="Ada École Lovelace",
                given_name="Ada",
                family_name="Lovelace",
                orcid=_ORCID,
                affiliations=(Affiliation(name="Université de Test"),),
            ),
        ),
        abstract="Graph retrieval alpha methods and results.",
        publication_date=None if year is None else f"{year}-06-01",
        publication_year=year,
        document_type=document_type,
        language=language,
        venue=venue,
        publisher=publisher,
        volume="10",
        issue="2",
        pages="1-20",
        identifiers=actual_identifiers,
        keywords=keywords,
    )


def _literature(
    number: int,
    *,
    meta_number: int | None = None,
    metadata: LiteratureMetadata | None = None,
    role: VersionRole = VersionRole.OTHER,
) -> Literature:
    return Literature(
        literature_id=LiteratureId(_uuid(number)),
        meta_literature_id=MetaLiteratureId(_uuid(number if meta_number is None else meta_number)),
        version_role=role,
        metadata=metadata or _metadata(number),
        status=LiteratureStatus.UNREVIEWED,
    )


def _observation(
    number: int,
    metadata: LiteratureMetadata,
    *,
    reference_texts: tuple[str, ...] = (),
) -> MetadataObservation:
    record_id = f"record-{number}"
    return MetadataObservation(
        observation_id=ObservationId(_uuid(number)),
        provenance=_provenance(
            10_000 + number,
            kind=SourceKind.METADATA_PROVIDER,
            source_name="fixture-provider",
            record_id=record_id,
            input_sha256=sha256_digest(record_id.encode()),
        ),
        metadata=metadata,
        reference_texts=reference_texts,
    )


def _matching_ids(
    connection: sqlite3.Connection,
    query: LibraryQuery,
) -> tuple[LiteratureId, ...]:
    matcher = getattr(literature_reader_module, "_select_matching_literature_ids")
    return cast(tuple[LiteratureId, ...], matcher(connection, query))


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
                connection.execute("SELECT count(*) FROM literatures").fetchone()
                entered, release = pause
                entered.set()
                if not release.wait(timeout=5):
                    raise RuntimeError("timed out waiting for query snapshot release")
            yield connection


class LiteratureReaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-literature-query-")
        self.addCleanup(self.temporary.cleanup)
        temporary_path = Path(self.temporary.name)
        self.engine = CatalogEngine(temporary_path / "catalog.sqlite")
        self.writer = LiteratureWriter(self.engine)
        self.storage_root = StorageRoot(temporary_path / "artifacts")
        self.artifact_store = ArtifactStore(self.storage_root)
        self.verified_reader = VerifiedReader(self.storage_root)
        self.reader = LiteratureReader(self.engine, self.verified_reader)
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

    def _publish_primary(
        self,
        literature: Literature,
        *,
        number: int,
    ) -> Asset:
        pdf = self._publish_artifact(
            f"%PDF-1.7\nfixture-{number}\n".encode(),
            media_type="application/pdf",
            artifact_id=f"pdf-{number}",
        )
        asset = Asset(
            asset_id=AssetId(_uuid(20_000 + number)),
            sha256=pdf.sha256,
            size_bytes=pdf.byte_size,
            media_type=pdf.media_type,
            path=pdf.path,
        )
        self.writer.publish_asset(asset)
        self.writer.publish_literature_asset(
            LiteratureAsset(
                literature_asset_id=LiteratureAssetId(_uuid(21_000 + number)),
                literature_id=literature.literature_id,
                asset_id=asset.asset_id,
                role=AssetRole.PRIMARY_PDF,
                provenance=_provenance(
                    22_000 + number,
                    kind=SourceKind.ASSET_PROVIDER,
                    source_name="fixture-assets",
                    record_id=f"asset-{number}",
                    input_sha256=pdf.sha256,
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
        parser_payload = f"# Parsed fixture {number}\n".encode()
        parser_markdown = self._publish_artifact(
            parser_payload,
            media_type="text/markdown",
            artifact_id=f"parser-markdown-{number}",
        )
        parser_provenance = ParserProvenance(
            provenance=_provenance(
                23_000 + number,
                kind=SourceKind.PARSER,
                source_name="fixture-parser",
                record_id=None,
                input_sha256=asset.sha256,
                parameters_sha256=_PARAMETERS_SHA256,
            ),
            parser_version="1.0",
            mode="offline",
        )
        markdown_ref = ParserArtifactRef(
            sha256=parser_markdown.sha256,
            media_type=parser_markdown.media_type,
            byte_size=parser_markdown.byte_size,
        )
        result = ParserResult(
            source_asset_id=asset.asset_id,
            source_sha256=asset.sha256,
            page_count=1,
            markdown=markdown_ref,
            result_sha256=parser_result_sha256(
                source_asset_id=asset.asset_id,
                source_sha256=asset.sha256,
                page_count=1,
                markdown=markdown_ref,
                resources=(),
                provenance=parser_provenance,
            ),
            provenance=parser_provenance,
        )
        self.parser_publication.publish_current(
            ParserResultPublicationCommand(
                result=result,
                markdown=StagedParserArtifact(
                    artifact=markdown_ref,
                    content=_RepeatableBytes(parser_payload),
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
    ) -> LiteratureContent:
        asset, parser_result = self._publish_primary_and_parser(
            literature,
            number=number,
        )
        sections = tuple(
            LiteratureSection(
                role=role,
                markdown=f"Alpha body for {role.value} {number}.",
            )
            for role in (
                LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
                LiteratureSectionRole.METHODS,
                LiteratureSectionRole.DATA,
                LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
            )
        )
        references = ("Reference fixture zero.", "Reference fixture one.")
        markdown_bytes = render_canonical_markdown(
            metadata=literature.metadata,
            sections=sections,
            references=references,
        )
        markdown = self.artifact_store.publish(
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
                sha256=markdown.sha256,
                byte_size=markdown.byte_size,
                media_type=markdown.media_type,
            ),
            provenance=_provenance(
                24_000 + number,
                kind=SourceKind.ANALYSIS,
                source_name="fixture-analysis",
                record_id=None,
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
                expected_token=self._token(literature),
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
        return content

    def test_matcher_covers_all_fields_and_keeps_concrete_versions(self) -> None:
        published = _literature(
            1,
            meta_number=100,
            metadata=_metadata(1, title="École Graph Retrieval"),
            role=VersionRole.PUBLISHED,
        )
        preprint = _literature(
            2,
            meta_number=100,
            metadata=_metadata(
                2,
                title="Preprint Graph Retrieval",
                year=2023,
                document_type="preprint",
            ),
            role=VersionRole.PREPRINT,
        )
        unrelated = _literature(
            3,
            metadata=_metadata(
                3,
                title="Chemistry Control",
                year=2020,
                language="zh",
                venue="Chemistry Journal",
                keywords=("chemistry",),
            ).model_copy(update={"abstract": "Chemistry control only."}),
        )
        first_observation = _observation(101, published.metadata)
        duplicate_source = _observation(102, published.metadata)
        self._publish_literatures(
            (published, preprint, unrelated),
            observations=(
                LiteratureObservation(
                    literature_id=published.literature_id,
                    observation=first_observation,
                ),
                LiteratureObservation(
                    literature_id=published.literature_id,
                    observation=duplicate_source,
                ),
            ),
        )
        self.writer.publish_exhaustion(
            AutomaticPdfAcquisitionExhaustion(literature_id=published.literature_id)
        )

        expected_all = {published.literature_id, preprint.literature_id, unrelated.literature_id}
        cases = (
            (LibraryQuery(), expected_all),
            (
                LibraryQuery(text="graph retrieval"),
                {published.literature_id, preprint.literature_id},
            ),
            (
                LibraryQuery(title="E\N{COMBINING ACUTE ACCENT}COLE graph"),
                {published.literature_id},
            ),
            (LibraryQuery(author="ÉCOLE lovelace"), expected_all),
            (LibraryQuery(author_orcids=(_ORCID,)), expected_all),
            (
                LibraryQuery(identifiers=(Identifier(namespace="doi", value="10.1000/1"),)),
                {published.literature_id},
            ),
            (
                LibraryQuery(publication_year_from=2023, publication_year_to=2024),
                {published.literature_id, preprint.literature_id},
            ),
            (
                LibraryQuery(venue="graph RETRIEVAL"),
                {published.literature_id, preprint.literature_id},
            ),
            (LibraryQuery(publisher="e\N{COMBINING ACUTE ACCENT}cole"), expected_all),
            (
                LibraryQuery(document_types=("preprint", "missing")),
                {preprint.literature_id},
            ),
            (LibraryQuery(languages=("zh",)), {unrelated.literature_id}),
            (
                LibraryQuery(keywords=("graph", "retrieval")),
                {published.literature_id, preprint.literature_id},
            ),
            (LibraryQuery(version_roles=(VersionRole.PREPRINT,)), {preprint.literature_id}),
            (
                LibraryQuery(statuses=(LiteratureStatus.UNREVIEWED,)),
                expected_all,
            ),
            (LibraryQuery(missing_steps=("primary-pdf",)), expected_all),
            (LibraryQuery(needs_manual_pdf=True), {published.literature_id}),
            (
                LibraryQuery(needs_manual_pdf=False),
                {preprint.literature_id, unrelated.literature_id},
            ),
            (
                LibraryQuery(title="graph", languages=("en",), keywords=("graph", "retrieval")),
                {published.literature_id, preprint.literature_id},
            ),
        )
        with self.engine.read_snapshot() as connection:
            for query, expected in cases:
                with self.subTest(query=query):
                    self.assertEqual(
                        set(_matching_ids(connection, query)),
                        expected,
                    )

        page = self.reader.search(LibrarySearchRequest(query=LibraryQuery(title="graph")))
        self.assertEqual(page.total_count, 2)
        self.assertEqual(
            {item.literature.literature_id for item in page.items},
            {published.literature_id, preprint.literature_id},
        )

    def test_keyword_filter_requires_every_keyword_not_merely_one(self) -> None:
        complete = _literature(
            4,
            metadata=_metadata(4, title="Complete keyword object", keywords=("graph", "retrieval")),
        )
        only_one = _literature(
            5,
            metadata=_metadata(5, title="One keyword object", keywords=("graph",)),
        )
        self._publish_literatures((complete, only_one))

        page = self.reader.search(
            LibrarySearchRequest(query=LibraryQuery(keywords=("graph", "retrieval")))
        )
        self.assertEqual(
            tuple(item.literature.literature_id for item in page.items),
            (complete.literature_id,),
        )

    def test_status_and_missing_step_filters_follow_the_complete_current_fact_truth_table(
        self,
    ) -> None:
        unreviewed = _literature(70, metadata=_metadata(70, title="Unreviewed"))
        pdf_without_parser = _literature(
            71,
            metadata=_metadata(71, title="Primary PDF without parser"),
        )
        parser_without_content = _literature(
            72,
            metadata=_metadata(72, title="Aligned parser without content"),
        )
        content_ready = _literature(
            73,
            metadata=_metadata(73, title="Content ready"),
        )
        stale_binding = _literature(
            74,
            metadata=_metadata(74, title="Stale parser binding"),
        )
        values = (
            unreviewed,
            pdf_without_parser,
            parser_without_content,
            content_ready,
            stale_binding,
        )
        self._publish_literatures(values)
        self._publish_primary(pdf_without_parser, number=71)
        self._publish_primary_and_parser(parser_without_content, number=72)
        self._publish_complete_content(content_ready, number=73)
        self._publish_primary_and_parser(stale_binding, number=74)
        with self.engine.write_transaction() as connection:
            connection.execute(
                "DELETE FROM literature_assets WHERE literature_id=? AND role='primary-pdf'",
                (stale_binding.literature_id.root,),
            )
        self._publish_primary(stale_binding, number=174)

        page = self.reader.search(LibrarySearchRequest(query=LibraryQuery()))
        projection = {
            item.literature.literature_id: (item.literature.status, item.missing_step)
            for item in page.items
        }
        self.assertEqual(
            projection,
            {
                unreviewed.literature_id: (LiteratureStatus.UNREVIEWED, "primary-pdf"),
                pdf_without_parser.literature_id: (
                    LiteratureStatus.ASSET_READY,
                    "parser-result",
                ),
                parser_without_content.literature_id: (
                    LiteratureStatus.ASSET_READY,
                    "literature-content",
                ),
                content_ready.literature_id: (LiteratureStatus.CONTENT_READY, None),
                stale_binding.literature_id: (
                    LiteratureStatus.ASSET_READY,
                    "parser-result",
                ),
            },
        )

        def matching(query: LibraryQuery) -> set[LiteratureId]:
            result = self.reader.search(LibrarySearchRequest(query=query))
            return {item.literature.literature_id for item in result.items}

        self.assertEqual(
            matching(LibraryQuery(statuses=(LiteratureStatus.UNREVIEWED,))),
            {unreviewed.literature_id},
        )
        self.assertEqual(
            matching(LibraryQuery(statuses=(LiteratureStatus.ASSET_READY,))),
            {
                pdf_without_parser.literature_id,
                parser_without_content.literature_id,
                stale_binding.literature_id,
            },
        )
        self.assertEqual(
            matching(LibraryQuery(statuses=(LiteratureStatus.CONTENT_READY,))),
            {content_ready.literature_id},
        )
        self.assertEqual(
            matching(LibraryQuery(missing_steps=("primary-pdf",))),
            {unreviewed.literature_id},
        )
        self.assertEqual(
            matching(LibraryQuery(missing_steps=("parser-result",))),
            {pdf_without_parser.literature_id, stale_binding.literature_id},
        )
        self.assertEqual(
            matching(LibraryQuery(missing_steps=("literature-content",))),
            {parser_without_content.literature_id},
        )

    def test_plain_fts_relevance_sort_and_punctuation_no_match(self) -> None:
        dense = _literature(
            10,
            metadata=_metadata(10, title="Alpha Alpha Alpha Retrieval"),
        )
        sparse = _literature(
            11,
            metadata=_metadata(11, title="Alpha Retrieval"),
        )
        no_alpha = _literature(
            12,
            metadata=_metadata(12, title="Beta Control").model_copy(
                update={"abstract": "Beta control only."}
            ),
        )
        self._publish_literatures((dense, sparse, no_alpha))

        request = LibrarySearchRequest(
            query=LibraryQuery(text='alpha" OR *'),
            sort="relevance",
        )
        page = self.reader.search(request)
        self.assertEqual(
            {item.literature.literature_id for item in page.items},
            {dense.literature_id, sparse.literature_id},
        )
        self.assertEqual(
            self.reader.search(
                LibrarySearchRequest(query=LibraryQuery(text='-- "" () ***'))
            ).total_count,
            0,
        )
        self.assertEqual(
            self.reader.search(LibrarySearchRequest(query=LibraryQuery())).total_count,
            3,
        )
        self.assertEqual(
            self.reader.search(
                LibrarySearchRequest(
                    query=LibraryQuery(text='alpha" OR *; DROP TABLE literatures;--')
                )
            ).total_count,
            0,
        )
        self.assertEqual(
            self.reader.search(LibrarySearchRequest(query=LibraryQuery())).total_count,
            3,
        )

    def test_real_catalog_fts_uses_one_unicode_pipeline_without_rewriting_display_text(
        self,
    ) -> None:
        nfc_title = (
            "Stra\N{LATIN SMALL LETTER SHARP S}e "
            "\N{LATIN CAPITAL LETTER I WITH DOT ABOVE}stanbul "
            "Caf\N{LATIN SMALL LETTER E WITH ACUTE} "
            "\N{CJK UNIFIED IDEOGRAPH-6771}\N{CJK UNIFIED IDEOGRAPH-4EAC}"
        )
        nfd_title = (
            "Stra\N{LATIN SMALL LETTER SHARP S}e "
            "\N{LATIN CAPITAL LETTER I WITH DOT ABOVE}stanbul "
            "Cafe\N{COMBINING ACUTE ACCENT} "
            "\N{CJK UNIFIED IDEOGRAPH-6771}\N{CJK UNIFIED IDEOGRAPH-4EAC}"
        )
        nfc = _literature(
            13,
            metadata=_metadata(13, title=nfc_title, identifiers=()),
        )
        nfd = _literature(
            14,
            metadata=_metadata(14, title=nfd_title, identifiers=()),
        )
        self._publish_literatures((nfc, nfd))

        for text in (
            "STRASSE",
            "\N{LATIN CAPITAL LETTER I WITH DOT ABOVE}STANBUL",
            "CAF\N{LATIN CAPITAL LETTER E WITH ACUTE}",
            "CAFE\N{COMBINING ACUTE ACCENT}",
            "\N{CJK UNIFIED IDEOGRAPH-6771}\N{CJK UNIFIED IDEOGRAPH-4EAC}",
        ):
            with self.subTest(text=text):
                page = self.reader.search(LibrarySearchRequest(query=LibraryQuery(text=text)))
                self.assertEqual(
                    {item.literature.literature_id for item in page.items},
                    {nfc.literature_id, nfd.literature_id},
                )

        page = self.reader.search(LibrarySearchRequest(query=LibraryQuery()))
        displayed = {
            item.literature.literature_id: item.literature.metadata.title for item in page.items
        }
        self.assertEqual(displayed[nfc.literature_id], nfc.metadata.title)
        self.assertEqual(displayed[nfd.literature_id], nfd.metadata.title)
        self.assertIn("Stra\N{LATIN SMALL LETTER SHARP S}e", displayed[nfc.literature_id] or "")
        self.assertIn(
            "\N{LATIN CAPITAL LETTER I WITH DOT ABOVE}stanbul",
            displayed[nfd.literature_id] or "",
        )

    def test_real_relevance_weights_id_ties_and_cursor_cover_multiple_pages(self) -> None:
        high = _literature(
            15,
            metadata=_metadata(
                15,
                title="Alpha alpha alpha alpha",
                identifiers=(),
            ).model_copy(update={"abstract": "alpha alpha alpha"}),
        )
        tie_earlier = _literature(
            16,
            metadata=_metadata(16, title="Alpha common", identifiers=()).model_copy(
                update={"abstract": "alpha common"}
            ),
        )
        tie_later = _literature(
            17,
            metadata=tie_earlier.metadata,
        )
        low = _literature(
            18,
            metadata=_metadata(18, title="Alpha", identifiers=()).model_copy(
                update={"abstract": "alpha " + ("filler " * 80).strip()}
            ),
        )
        self._publish_literatures((high, tie_earlier, tie_later, low))
        with self.engine.read_snapshot() as connection:
            scores = {
                LiteratureId(str(row[0])): float(row[1])
                for row in connection.execute(
                    "SELECT literature_id,bm25(literature_search_fts) "
                    "FROM literature_search_fts WHERE literature_search_fts MATCH ?",
                    ('"alpha"',),
                ).fetchall()
            }
        self.assertLess(scores[high.literature_id], scores[low.literature_id])
        self.assertEqual(scores[tie_earlier.literature_id], scores[tie_later.literature_id])

        request = LibrarySearchRequest(
            query=LibraryQuery(text="alpha"),
            sort="relevance",
            limit=2,
        )
        first = self.reader.search(request)
        self.assertEqual(first.total_count, 4)
        self.assertIsNotNone(first.next_cursor)
        second = self.reader.search(request.model_copy(update={"cursor": first.next_cursor}))
        self.assertEqual(second.total_count, 4)
        self.assertIsNone(second.next_cursor)
        actual = tuple(item.literature.literature_id for item in (*first.items, *second.items))
        expected = tuple(sorted(scores, key=lambda item: (scores[item], item.root)))
        self.assertEqual(actual, expected)
        self.assertLess(
            actual.index(tie_earlier.literature_id), actual.index(tie_later.literature_id)
        )

    def test_five_sorts_nulls_cursor_binding_and_snapshot_total(self) -> None:
        values = (
            _literature(20, metadata=_metadata(20, title="Zulu", year=2025)),
            _literature(21, metadata=_metadata(21, title="alpha", year=2025)),
            _literature(22, metadata=_metadata(22, title="Beta", year=2020)),
            _literature(
                23,
                metadata=_metadata(
                    23,
                    title=None,
                    year=None,
                    identifiers=(Identifier(namespace="doi", value="10.1000/null"),),
                ).model_copy(update={"title": None}),
            ),
        )
        self._publish_literatures(values)
        expected_orders: dict[LibrarySort, tuple[int, ...]] = {
            "publication-year-desc": (20, 21, 22, 23),
            "publication-year-asc": (22, 20, 21, 23),
            "title-asc": (21, 22, 20, 23),
            "title-desc": (20, 22, 21, 23),
        }
        for sort, numbers in expected_orders.items():
            request = LibrarySearchRequest(query=LibraryQuery(), sort=sort, limit=2)
            first = self.reader.search(request)
            self.assertEqual(first.total_count, 4)
            self.assertIsNotNone(first.next_cursor)
            second = self.reader.search(
                request.model_copy(update={"limit": 10, "cursor": first.next_cursor})
            )
            self.assertEqual(second.total_count, 4)
            actual = tuple(item.literature.literature_id for item in (*first.items, *second.items))
            expected = tuple(LiteratureId(_uuid(number)) for number in numbers)
            with self.subTest(sort=sort):
                self.assertEqual(actual, expected)
            with self.assertRaises(LiteratureCursorError):
                self.reader.search(
                    LibrarySearchRequest(
                        query=LibraryQuery(title="different"),
                        sort=sort,
                        cursor=first.next_cursor,
                    )
                )

        relevance = self.reader.search(
            LibrarySearchRequest(
                query=LibraryQuery(text="zulu"),
                sort="relevance",
                limit=1,
            )
        )
        self.assertEqual(relevance.total_count, 1)

    def test_discovery_filter_restores_historical_concrete_versions_from_causes(self) -> None:
        historical = _literature(
            30,
            meta_number=300,
            metadata=_metadata(30, title="Historical preprint"),
            role=VersionRole.PREPRINT,
        )
        current_representative = _literature(
            31,
            meta_number=300,
            metadata=_metadata(31, title="Current published version"),
            role=VersionRole.PUBLISHED,
        )
        seed = _literature(32, metadata=_metadata(32, title="Citation seed"))
        historical_observation = _observation(330, historical.metadata)
        current_observation = _observation(331, current_representative.metadata)
        self._publish_literatures(
            (current_representative, historical, seed),
            observations=(
                LiteratureObservation(
                    literature_id=historical.literature_id,
                    observation=historical_observation,
                ),
                LiteratureObservation(
                    literature_id=current_representative.literature_id,
                    observation=current_observation,
                ),
            ),
        )
        topic_run = DiscoveryRunId(_uuid(340))
        citation_run = DiscoveryRunId(_uuid(341))
        with self.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO discovery_runs VALUES(?,?,?,?)",
                (topic_run.root, "topic", "COMPLETED", _TIMESTAMP.root),
            )
            connection.execute(
                "INSERT INTO topic_discovery_inputs VALUES(?,?,?,?,?)",
                (topic_run.root, "topic", "historical", None, None),
            )
            connection.execute(
                "INSERT INTO discovery_results VALUES(?,?)",
                (topic_run.root, historical.meta_literature_id.root),
            )
            connection.execute(
                "INSERT INTO topic_discovery_causes VALUES(?,?,?,?)",
                (
                    topic_run.root,
                    historical.meta_literature_id.root,
                    historical_observation.observation_id.root,
                    historical.literature_id.root,
                ),
            )
            connection.execute(
                "INSERT INTO discovery_runs VALUES(?,?,?,?)",
                (citation_run.root, "citation", "COMPLETED", _TIMESTAMP.root),
            )
            connection.execute(
                "INSERT INTO citation_discovery_inputs VALUES(?,?,?,?,?)",
                (citation_run.root, "citation", "references", 1, 10),
            )
            connection.execute(
                "INSERT INTO discovery_results VALUES(?,?)",
                (citation_run.root, historical.meta_literature_id.root),
            )
            connection.execute(
                "INSERT INTO citation_discovery_causes VALUES(?,?,?,?,?,?)",
                (
                    citation_run.root,
                    historical.meta_literature_id.root,
                    current_representative.literature_id.root,
                    historical.literature_id.root,
                    historical.literature_id.root,
                    1,
                ),
            )

        for run_id in (topic_run, citation_run):
            page = self.reader.search(
                LibrarySearchRequest(query=LibraryQuery(discovery_run_ids=(run_id,)))
            )
            with self.subTest(run_id=run_id):
                self.assertEqual(
                    tuple(item.literature.literature_id for item in page.items),
                    (historical.literature_id,),
                )
                self.assertNotIn(
                    current_representative.literature_id,
                    {item.literature.literature_id for item in page.items},
                )

    def test_matcher_fails_closed_on_corrupted_discovery_cause_closure(self) -> None:
        first = _literature(35, metadata=_metadata(35, title="First endpoint"))
        discovered = _literature(36, metadata=_metadata(36, title="Discovered endpoint"))
        wrong_meta = _literature(37, metadata=_metadata(37, title="Wrong result Meta"))
        observation = _observation(335, discovered.metadata)
        self._publish_literatures(
            (first, discovered, wrong_meta),
            observations=(
                LiteratureObservation(
                    literature_id=discovered.literature_id,
                    observation=observation,
                ),
            ),
        )
        topic_run = DiscoveryRunId(_uuid(345))
        citation_run = DiscoveryRunId(_uuid(346))
        with self.engine.write_transaction() as connection:
            connection.execute(
                "INSERT INTO discovery_runs VALUES(?,?,?,?)",
                (topic_run.root, "topic", "COMPLETED", _TIMESTAMP.root),
            )
            connection.execute(
                "INSERT INTO topic_discovery_inputs VALUES(?,?,?,?,?)",
                (topic_run.root, "topic", "corrupt", None, None),
            )
            # Establish the otherwise legal result before writing its bad cause.
            connection.execute(
                "INSERT INTO discovery_results VALUES(?,?)",
                (topic_run.root, discovered.meta_literature_id.root),
            )
            connection.execute(
                "INSERT INTO discovery_runs VALUES(?,?,?,?)",
                (citation_run.root, "citation", "COMPLETED", _TIMESTAMP.root),
            )
            connection.execute(
                "INSERT INTO citation_discovery_inputs VALUES(?,?,?,?,?)",
                (citation_run.root, "citation", "references", 1, 10),
            )
            connection.execute(
                "INSERT INTO discovery_results VALUES(?,?)",
                (citation_run.root, wrong_meta.meta_literature_id.root),
            )

        connection = sqlite3.connect(self.engine.catalog_path, isolation_level=None)
        self.addCleanup(connection.close)
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute("DROP TRIGGER topic_discovery_cause_insert_closure")
        connection.execute("DROP TRIGGER citation_discovery_cause_insert_closure")
        connection.execute(
            "INSERT INTO topic_discovery_causes VALUES(?,?,?,?)",
            (
                topic_run.root,
                discovered.meta_literature_id.root,
                observation.observation_id.root,
                first.literature_id.root,
            ),
        )
        connection.execute(
            "INSERT INTO citation_discovery_causes VALUES(?,?,?,?,?,?)",
            (
                citation_run.root,
                wrong_meta.meta_literature_id.root,
                first.literature_id.root,
                discovered.literature_id.root,
                first.literature_id.root,
                1,
            ),
        )
        for run_id in (topic_run, citation_run):
            with (
                self.subTest(run_id=run_id),
                self.assertRaisesRegex(
                    LiteratureReaderError,
                    "^literature query read failed$",
                ) as captured,
            ):
                _matching_ids(connection, LibraryQuery(discovery_run_ids=(run_id,)))
            self.assertIsNone(captured.exception.__cause__)

    def test_detail_strictly_rebuilds_content_assets_versions_and_counts(self) -> None:
        source = _literature(
            40,
            meta_number=400,
            metadata=_metadata(40, title="Detailed source"),
            role=VersionRole.PUBLISHED,
        )
        other_version = _literature(
            41,
            meta_number=400,
            metadata=_metadata(41, title="Detailed preprint"),
            role=VersionRole.PREPRINT,
        )
        target = _literature(42, metadata=_metadata(42, title="Detail target"))
        source_observation = _observation(
            440,
            source.metadata,
            reference_texts=("Target reference.",),
        )
        self._publish_literatures(
            (source, other_version, target),
            observations=(
                LiteratureObservation(
                    literature_id=source.literature_id,
                    observation=source_observation,
                ),
            ),
        )
        content = self._publish_complete_content(source, number=40)
        additional = self._publish_artifact(
            b"<html>supplement</html>",
            media_type="text/html",
            artifact_id="detail-additional",
        )
        additional_asset = Asset(
            asset_id=AssetId(_uuid(25_040)),
            sha256=additional.sha256,
            size_bytes=additional.byte_size,
            media_type=additional.media_type,
            path=additional.path,
        )
        self.writer.publish_asset(additional_asset)
        self.writer.publish_literature_asset(
            LiteratureAsset(
                literature_asset_id=LiteratureAssetId(_uuid(26_040)),
                literature_id=source.literature_id,
                asset_id=additional_asset.asset_id,
                role=AssetRole.HTML,
                provenance=_provenance(
                    27_040,
                    kind=SourceKind.ASSET_PROVIDER,
                    source_name="fixture-assets",
                    record_id="supplement",
                    input_sha256=additional.sha256,
                ),
            )
        )
        reference = Reference(
            reference_id=ReferenceId(_uuid(450)),
            source_literature_id=source.literature_id,
            target_literature_id=target.literature_id,
        )
        self.writer.publish_reference(
            ReferencePublicationCommand(
                source_token=self._token(source),
                target_token=self._token(target),
                reference=reference,
                supports=(
                    ReferenceSupport(
                        reference_id=reference.reference_id,
                        source=MetadataReferenceTextSupport(
                            kind="metadata_reference_text",
                            metadata_observation_id=source_observation.observation_id,
                            reference_index=0,
                        ),
                    ),
                ),
            )
        )

        detail = self.reader.read_detail(source.literature_id)
        self.assertEqual(detail.literature.status, LiteratureStatus.CONTENT_READY)
        self.assertIsNone(detail.missing_step)
        self.assertEqual(detail.content, content)
        primary_pdf = detail.primary_pdf
        self.assertIsNotNone(primary_pdf)
        assert primary_pdf is not None
        self.assertEqual(len(detail.additional_assets), 1)
        self.assertEqual(
            tuple(item.observation_id for item in detail.metadata_observations),
            (source_observation.observation_id,),
        )
        self.assertEqual(
            tuple(item.literature.literature_id for item in detail.other_versions),
            (other_version.literature_id,),
        )
        self.assertEqual((detail.reference_count, detail.cited_by_count), (1, 0))
        self.assertFalse(hasattr(primary_pdf.asset, "bytes"))
        with self.assertRaisesRegex(
            LiteratureReaderNotFoundError,
            "^literature query object was not found$",
        ):
            self.reader.read_detail(LiteratureId(_uuid(999_999)))

    def test_detail_fails_closed_for_every_structured_content_integrity_failure(self) -> None:
        variants = {
            "missing": _literature(80, metadata=_metadata(80, title="Missing structured")),
            "invalid-json": _literature(
                81,
                metadata=_metadata(81, title="Invalid structured JSON"),
            ),
            "hash-mismatch": _literature(
                82,
                metadata=_metadata(82, title="Structured hash mismatch"),
            ),
            "size-mismatch": _literature(
                83,
                metadata=_metadata(83, title="Structured size mismatch"),
            ),
            "media-mismatch": _literature(
                84,
                metadata=_metadata(84, title="Structured media mismatch"),
            ),
        }
        self._publish_literatures(tuple(variants.values()))
        for number, literature in enumerate(variants.values(), start=80):
            self._publish_complete_content(literature, number=number)

        descriptors: dict[str, tuple[str, str, int, str]] = {}
        with self.engine.read_snapshot() as connection:
            for name, literature in variants.items():
                row = connection.execute(
                    "SELECT structured_artifact_path,structured_artifact_sha256,"
                    "structured_artifact_byte_size,structured_artifact_media_type "
                    "FROM literature_contents WHERE literature_id=?",
                    (literature.literature_id.root,),
                ).fetchone()
                self.assertIsNotNone(row)
                assert row is not None
                descriptors[name] = (str(row[0]), str(row[1]), int(row[2]), str(row[3]))

        missing_path = self.storage_root.canonical_path / descriptors["missing"][0]
        missing_path.unlink()

        invalid = self._publish_artifact(
            b'{"broken":true}',
            media_type="application/json",
            artifact_id="invalid-structured-json",
        )
        with self.engine.write_transaction() as connection:
            connection.execute(
                "UPDATE literature_contents SET structured_artifact_path=?,"
                "structured_artifact_sha256=?,structured_artifact_byte_size=?,"
                "structured_artifact_media_type=? WHERE literature_id=?",
                (
                    invalid.path.root,
                    invalid.sha256.root,
                    invalid.byte_size,
                    invalid.media_type,
                    variants["invalid-json"].literature_id.root,
                ),
            )

        hash_path = self.storage_root.canonical_path / descriptors["hash-mismatch"][0]
        hash_bytes = hash_path.read_bytes()
        hash_path.write_bytes(bytes((hash_bytes[0] ^ 1,)) + hash_bytes[1:])

        size_path = self.storage_root.canonical_path / descriptors["size-mismatch"][0]
        with size_path.open("ab") as stream:
            stream.write(b"x")

        media_path, _media_hash, _media_size, _media_type = descriptors["media-mismatch"]
        with self.engine.write_transaction() as connection:
            connection.execute("PRAGMA defer_foreign_keys=ON")
            connection.execute(
                "UPDATE literature_contents SET structured_artifact_media_type=? "
                "WHERE literature_id=?",
                ("text/plain", variants["media-mismatch"].literature_id.root),
            )
            connection.execute(
                "UPDATE artifact_objects SET media_type=? WHERE relative_path=?",
                ("text/plain", media_path),
            )

        for name, literature in variants.items():
            with (
                self.subTest(variant=name),
                self.assertRaisesRegex(
                    LiteratureReaderError,
                    "^literature query read failed$",
                ) as captured,
            ):
                self.reader.read_detail(literature.literature_id)
            message = str(captured.exception)
            self.assertNotIn(str(self.storage_root.canonical_path), message)
            self.assertNotIn(str(self.engine.catalog_path), message)
            self.assertIsNone(captured.exception.__cause__)
            self.assertTrue(captured.exception.__suppress_context__)

    def test_reference_pages_detail_supports_auxiliary_reads_and_one_snapshot_each(self) -> None:
        source = _literature(50, metadata=_metadata(50, title="Reference source", year=2020))
        newest = _literature(51, metadata=_metadata(51, title="Zulu", year=2026))
        alpha = _literature(52, metadata=_metadata(52, title="alpha", year=2025))
        beta = _literature(53, metadata=_metadata(53, title="Beta", year=2025))
        source_observation = _observation(
            550,
            source.metadata,
            reference_texts=("Newest.", "Alpha.", "Beta."),
        )
        self._publish_literatures(
            (source, newest, alpha, beta),
            observations=(
                LiteratureObservation(
                    literature_id=source.literature_id,
                    observation=source_observation,
                ),
            ),
        )
        provider_relation = ProviderRelationObservation(
            observation_id=ObservationId(_uuid(551)),
            provenance=_provenance(
                10_551,
                kind=SourceKind.METADATA_PROVIDER,
                source_name="fixture-provider",
                record_id="relation-551",
                input_sha256=sha256_digest(b"relation-551"),
            ),
            citing=ProviderLiteratureKey(
                identifiers=source.metadata.identifiers,
            ),
            cited=ProviderLiteratureKey(
                identifiers=newest.metadata.identifiers,
            ),
        )
        self.writer.publish_provider_relation_observation(provider_relation)
        references: list[Reference] = []
        for index, target in enumerate((newest, alpha, beta)):
            reference = Reference(
                reference_id=ReferenceId(_uuid(560 + index)),
                source_literature_id=source.literature_id,
                target_literature_id=target.literature_id,
            )
            supports = [
                ReferenceSupport(
                    reference_id=reference.reference_id,
                    source=MetadataReferenceTextSupport(
                        kind="metadata_reference_text",
                        metadata_observation_id=source_observation.observation_id,
                        reference_index=index,
                    ),
                )
            ]
            if index == 0:
                supports.append(
                    ReferenceSupport(
                        reference_id=reference.reference_id,
                        source=ProviderRelationSupport(
                            kind="provider_relation",
                            observation_id=provider_relation.observation_id,
                        ),
                    )
                )
            self.writer.publish_reference(
                ReferencePublicationCommand(
                    source_token=self._token(source),
                    target_token=self._token(target),
                    reference=reference,
                    supports=tuple(supports),
                )
            )
            references.append(reference)

        counting_engine = _CountingCatalogEngine(self.engine.catalog_path)
        reader = LiteratureReader(counting_engine, self.verified_reader)
        search = reader.search(LibrarySearchRequest(query=LibraryQuery()))
        self.assertEqual(counting_engine.read_snapshot_calls, 1)
        self.assertEqual(search.total_count, 4)
        reader.read_detail(source.literature_id)
        self.assertEqual(counting_engine.read_snapshot_calls, 2)
        request = LiteratureReferenceRequest(
            literature_id=source.literature_id,
            direction="references",
            limit=2,
        )
        first = reader.read_references(request)
        self.assertEqual(counting_engine.read_snapshot_calls, 3)
        self.assertEqual(first.total_count, 3)
        self.assertEqual(
            tuple(item.related_literature.literature.literature_id for item in first.items),
            (newest.literature_id, alpha.literature_id),
        )
        self.assertEqual(first.items[0].support_count, 2)
        second = reader.read_references(
            request.model_copy(update={"limit": 10, "cursor": first.next_cursor})
        )
        self.assertEqual(counting_engine.read_snapshot_calls, 4)
        self.assertEqual(
            tuple(item.related_literature.literature.literature_id for item in second.items),
            (beta.literature_id,),
        )
        reverse = reader.read_references(
            LiteratureReferenceRequest(
                literature_id=newest.literature_id,
                direction="cited-by",
            )
        )
        self.assertEqual(counting_engine.read_snapshot_calls, 5)
        self.assertEqual(reverse.items[0].reference, references[0])
        detail = reader.read_reference_detail(references[0].reference_id)
        self.assertEqual(counting_engine.read_snapshot_calls, 6)
        self.assertEqual(detail.source.literature.literature_id, source.literature_id)
        self.assertEqual(detail.target.literature.literature_id, newest.literature_id)
        self.assertEqual(len(detail.supports), 2)
        meta = reader.read_meta_literatures(
            MetaLiteratureReadRequest(meta_literature_ids=(source.meta_literature_id,))
        )
        self.assertEqual(counting_engine.read_snapshot_calls, 7)
        self.assertEqual(
            tuple(item.literature.literature_id for item in meta.facts),
            (source.literature_id,),
        )
        provider = reader.read_provider_relation_observations(
            ProviderRelationObservationReadRequest(
                observation_ids=(
                    ObservationId(_uuid(999_998)),
                    provider_relation.observation_id,
                )
            )
        )
        self.assertEqual(counting_engine.read_snapshot_calls, 8)
        self.assertEqual(provider.observations, (provider_relation,))

    def test_concurrent_commit_cannot_split_one_search_snapshot(self) -> None:
        literature = _literature(
            60,
            metadata=_metadata(60, title="Old snapshot title"),
        )
        self._publish_literatures((literature,))
        counting_engine = _CountingCatalogEngine(self.engine.catalog_path)
        reader = LiteratureReader(counting_engine, self.verified_reader)
        entered = threading.Event()
        release = threading.Event()
        counting_engine.pause_next_snapshot(entered, release)
        result: list[LibrarySearchPage | BaseException] = []

        def read_page() -> None:
            try:
                result.append(reader.search(LibrarySearchRequest(query=LibraryQuery())))
            except BaseException as error:  # pragma: no cover - assertion reports it.
                result.append(error)

        thread = threading.Thread(target=read_page)
        thread.start()
        self.assertTrue(entered.wait(timeout=5))
        replacement_metadata = literature.metadata.model_copy(
            update={"title": "New snapshot title"}
        )
        with self.engine.write_transaction() as connection:
            connection.execute(
                "UPDATE literature_metadata SET title=?,metadata_sha256=? WHERE literature_id=?",
                (
                    replacement_metadata.title,
                    metadata_sha256(replacement_metadata).root,
                    literature.literature_id.root,
                ),
            )
            connection.execute(
                "UPDATE literature_search_fts SET title=? WHERE literature_id=?",
                (replacement_metadata.title, literature.literature_id.root),
            )
        release.set()
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(counting_engine.read_snapshot_calls, 1)
        self.assertEqual(len(result), 1)
        self.assertFalse(isinstance(result[0], BaseException), result[0])
        old_page = cast(LibrarySearchPage, result[0])
        self.assertEqual(old_page.items[0].literature.metadata.title, "Old snapshot title")
        new_page = reader.search(LibrarySearchRequest(query=LibraryQuery()))
        self.assertEqual(new_page.items[0].literature.metadata.title, "New snapshot title")
        self.assertEqual(counting_engine.read_snapshot_calls, 2)

    def test_stable_reader_error_does_not_expose_catalog_path_or_sql(self) -> None:
        with self.engine.write_transaction() as connection:
            connection.execute("DROP TABLE literature_search_fts")
        with self.assertRaisesRegex(
            LiteratureReaderError,
            "^literature query read failed$",
        ) as captured:
            self.reader.search(LibrarySearchRequest(query=LibraryQuery(text="alpha")))
        message = str(captured.exception)
        self.assertNotIn(str(self.engine.catalog_path), message)
        self.assertNotIn("SELECT", message)
        self.assertIsNone(captured.exception.__cause__)
        self.assertTrue(captured.exception.__suppress_context__)


if __name__ == "__main__":
    unittest.main()
