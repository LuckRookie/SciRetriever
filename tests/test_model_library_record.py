from __future__ import annotations

import unittest

from pydantic import BaseModel, ValidationError

from sciretriever.model.acquisition import Asset, AssetRole, LiteratureAsset
from sciretriever.model.analysis import (
    ArtifactRef,
    LiteratureContent,
    LiteratureSection,
    LiteratureSectionRole,
)
from sciretriever.model.library import (
    LibraryQuery,
    LibrarySearchPage,
    LibrarySearchRequest,
    LiteratureAssetView,
    LiteratureDetail,
    LiteratureMissingStep,
    LiteratureReferenceItem,
    LiteratureReferencePage,
    LiteratureReferenceRequest,
    LiteratureSearchItem,
    ReferenceDetail,
)
from sciretriever.model.literature import (
    Author,
    AuthorKind,
    Identifier,
    Literature,
    LiteratureStatus,
    MetaLiterature,
    Reference,
    ReferenceSupport,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.parsing import (
    ParserArtifactRef,
    ParserProvenance,
    ParserResult,
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
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.record import BibliographicRecord

_ID = "123e4567-e89b-12d3-a456-426614174000"
_ID_2 = "223e4567-e89b-12d3-a456-426614174000"
_ID_3 = "323e4567-e89b-12d3-a456-426614174000"
_ID_4 = "423e4567-e89b-12d3-a456-426614174000"
_HASH = "a" * 64
_HASH_2 = "b" * 64
_TIMESTAMP = UtcTimestamp("2026-08-10T12:34:56.123Z")


def _provenance(*, source_kind: SourceKind = SourceKind.METADATA_PROVIDER) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(_ID),
        source_kind=source_kind,
        source_name="crossref" if source_kind is SourceKind.METADATA_PROVIDER else "mineru",
        source_record_id="record-1" if source_kind is SourceKind.METADATA_PROVIDER else None,
        observed_at=_TIMESTAMP,
        input_sha256=Sha256(_HASH),
        parameters_sha256=None,
    )


def _metadata(*, title: str | None = "A study") -> LiteratureMetadata:
    return LiteratureMetadata(
        title=title,
        authors=(
            Author(
                kind=AuthorKind.PERSON,
                display_name="Ada Lovelace",
                given_name="Ada",
                family_name="Lovelace",
                orcid="0000-0002-1825-0097",
            ),
        ),
        abstract="An abstract.",
        publication_year=2026,
        document_type="journal-article",
        language="en",
        venue="Journal of Examples",
        publisher="Example Press",
        identifiers=(Identifier(namespace="doi", value="10.1000/example"),),
        keywords=("literature", "models"),
    )


def _literature(
    *,
    literature_id: str = _ID,
    meta_literature_id: str = _ID_2,
    title: str | None = "A study",
    role: VersionRole = VersionRole.PUBLISHED,
    status: LiteratureStatus = LiteratureStatus.CONTENT_READY,
) -> Literature:
    return Literature(
        literature_id=LiteratureId(literature_id),
        meta_literature_id=MetaLiteratureId(meta_literature_id),
        version_role=role,
        metadata=_metadata(title=title),
        status=status,
    )


def _search_item(
    *,
    literature: Literature | None = None,
    literature_id: str = _ID,
    missing_step: LiteratureMissingStep | None = None,
) -> LiteratureSearchItem:
    return LiteratureSearchItem(
        literature=literature or _literature(literature_id=literature_id),
        metadata_revision=2,
        metadata_sha256=Sha256(_HASH),
        missing_step=missing_step,
        needs_manual_pdf=missing_step == "primary-pdf",
    )


def _asset_view() -> LiteratureAssetView:
    return LiteratureAssetView(
        asset=Asset(
            asset_id=AssetId(_ID_3),
            sha256=Sha256(_HASH),
            size_bytes=12,
            media_type="application/pdf",
            path=RelativeArtifactPath("pdf/a.pdf"),
        ),
        literature_asset=LiteratureAsset(
            literature_asset_id=LiteratureAssetId(_ID_4),
            literature_id=LiteratureId(_ID),
            asset_id=AssetId(_ID_3),
            role=AssetRole.PRIMARY_PDF,
            provenance=Provenance(
                provenance_id=ProvenanceId(_ID_2),
                source_kind=SourceKind.ASSET_PROVIDER,
                source_name="open-access",
                source_record_id="asset-1",
                observed_at=_TIMESTAMP,
                input_sha256=Sha256(_HASH),
                parameters_sha256=None,
            ),
            source_url="https://example.test/paper.pdf",
        ),
    )


def _observation() -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_ID_3),
        provenance=_provenance(),
        metadata=_metadata(),
    )


def _parser_result() -> ParserResult:
    markdown = ParserArtifactRef(sha256=Sha256(_HASH), media_type="text/markdown", byte_size=1)
    provenance = ParserProvenance(
        provenance=Provenance(
            provenance_id=ProvenanceId(_ID_4),
            source_kind=SourceKind.PARSER,
            source_name="mineru",
            source_record_id=None,
            observed_at=_TIMESTAMP,
            input_sha256=Sha256(_HASH),
            parameters_sha256=Sha256(_HASH_2),
        ),
        parser_version="1.0",
    )
    from sciretriever.model.parsing import parser_result_sha256

    return ParserResult(
        source_asset_id=AssetId(_ID_3),
        source_sha256=Sha256(_HASH),
        page_count=1,
        markdown=markdown,
        result_sha256=parser_result_sha256(
            source_asset_id=AssetId(_ID_3),
            source_sha256=Sha256(_HASH),
            page_count=1,
            markdown=markdown,
            resources=(),
            provenance=provenance,
        ),
        provenance=provenance,
    )


def _content() -> LiteratureContent:
    sections = (
        LiteratureSection(
            role=LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
            markdown="Background",
        ),
        LiteratureSection(role=LiteratureSectionRole.METHODS, markdown="Methods"),
        LiteratureSection(role=LiteratureSectionRole.DATA, markdown="Data"),
        LiteratureSection(
            role=LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
            markdown="Conclusion",
        ),
    )
    from sciretriever.model.analysis import content_sha256

    return LiteratureContent(
        literature_content_sha256=content_sha256(
            metadata_sha256=Sha256(_HASH), sections=sections, references=()
        ),
        metadata_revision=2,
        metadata_sha256=Sha256(_HASH),
        sections=sections,
        markdown=ArtifactRef(sha256=Sha256(_HASH_2), media_type="text/markdown", byte_size=1),
        provenance=Provenance(
            provenance_id=ProvenanceId(_ID_4),
            source_kind=SourceKind.ANALYSIS,
            source_name="model",
            source_record_id=None,
            observed_at=_TIMESTAMP,
            input_sha256=Sha256(_HASH),
            parameters_sha256=Sha256(_HASH_2),
        ),
    )


class ModelContractTests(unittest.TestCase):
    def test_query_is_closed_immutable_and_normalizes_multi_values(self) -> None:
        identifier = Identifier(namespace="doi", value="10.1000/example")
        query = LibraryQuery.model_validate(
            {
                "text": "  methods  ",
                "title": "  study ",
                "author": " Ada ",
                "author_orcids": [
                    "0000-0002-1825-0097",
                    "0000-0002-1825-0097",
                ],
                "identifiers": [identifier, identifier],
                "publication_year_from": 2020,
                "publication_year_to": 2026,
                "venue": " Journal ",
                "publisher": " Press ",
                "document_types": ["article", "article", "review"],
                "languages": ["en", "en"],
                "keywords": ["models", "methods", "models"],
                "version_roles": [
                    VersionRole.PUBLISHED,
                    "preprint",
                    VersionRole.PUBLISHED,
                ],
                "statuses": [
                    LiteratureStatus.CONTENT_READY,
                    "ASSET_READY",
                    LiteratureStatus.CONTENT_READY,
                ],
                "missing_steps": ["parser-result", "primary-pdf", "parser-result"],
                "discovery_run_ids": ["123e4567-e89b-12d3-a456-426614174000"],
            }
        )

        self.assertEqual(query.text, "methods")
        self.assertEqual(query.author_orcids, ("0000-0002-1825-0097",))
        self.assertEqual(query.identifiers, (identifier,))
        self.assertEqual(query.document_types, ("article", "review"))
        self.assertEqual(query.keywords, ("models", "methods"))
        self.assertEqual(query.version_roles, (VersionRole.PUBLISHED, VersionRole.PREPRINT))
        self.assertEqual(
            query.statuses,
            (LiteratureStatus.CONTENT_READY, LiteratureStatus.ASSET_READY),
        )
        self.assertEqual(query.discovery_run_ids, (query.discovery_run_ids[0],))
        self.assertEqual(LibraryQuery.model_validate_json(query.model_dump_json()), query)
        with self.assertRaises(ValidationError):
            query.title = "changed"  # type: ignore[misc]
        with self.assertRaises(ValidationError):
            LibraryQuery(sql="select * from literature")  # type: ignore[call-arg]

    def test_query_rejects_blank_values_invalid_ranges_and_non_query_fields(self) -> None:
        for field in (
            "text",
            "title",
            "author",
            "venue",
            "publisher",
        ):
            with self.subTest(field=field), self.assertRaises(ValidationError):
                LibraryQuery.model_validate({field: "   "})
        for values in (
            {"publication_year_from": 2027, "publication_year_to": 2026},
            {"publication_year_from": 0},
            {"publication_year_to": 10000},
            {"author_orcids": ("not-an-orcid",)},
            {"missing_steps": ("all-missing",)},
            {"statuses": ("partial",)},
            {"version_roles": ("formal",)},
            {"identifiers": ("10.1000/example",)},
            {"path": "/absolute/file.pdf"},
            {"provider": "crossref"},
        ):
            with self.subTest(values=values), self.assertRaises(ValidationError):
                LibraryQuery.model_validate(values)

    def test_search_request_page_and_reference_request_boundaries(self) -> None:
        query = LibraryQuery(text="methods")
        request = LibrarySearchRequest(query=query)
        self.assertEqual(request.sort, "publication-year-desc")
        self.assertEqual(request.limit, 50)
        self.assertIsNone(request.cursor)
        self.assertEqual(LibrarySearchRequest(query=query, sort="relevance").sort, "relevance")
        with self.assertRaises(ValidationError):
            LibrarySearchRequest(query=LibraryQuery(), sort="relevance")
        with self.assertRaises(ValidationError):
            LibrarySearchRequest(query=query, limit=0)
        with self.assertRaises(ValidationError):
            LibrarySearchRequest(query=query, cursor="   ")

        item = _search_item()
        second = _search_item(literature_id=_ID_3)
        page = LibrarySearchPage.model_validate(
            {"items": [item, second], "total_count": 2, "next_cursor": "opaque:next"}
        )
        self.assertEqual(page.items, (item, second))
        self.assertEqual(LibrarySearchPage.model_validate_json(page.model_dump_json()), page)
        with self.assertRaises(ValidationError):
            LibrarySearchPage(items=(item, item), total_count=2)
        with self.assertRaises(ValidationError):
            LibrarySearchPage(items=(), total_count=-1)

        reference_request = LiteratureReferenceRequest(
            literature_id=LiteratureId(_ID), direction="cited-by"
        )
        self.assertEqual(reference_request.limit, 50)
        with self.assertRaises(ValidationError):
            LiteratureReferenceRequest(
                literature_id=LiteratureId(_ID),
                direction="both",  # type: ignore[arg-type]
            )
        with self.assertRaises(ValidationError):
            LiteratureReferenceRequest(
                literature_id=LiteratureId(_ID), direction="references", limit=0
            )

    def test_search_item_and_detail_reuse_existing_models_without_duplicate_fields(self) -> None:
        literature = _literature(status=LiteratureStatus.ASSET_READY)
        item = _search_item(literature=literature, missing_step="parser-result")
        self.assertIs(item.literature, literature)
        self.assertNotIn("metadata", LiteratureSearchItem.model_fields)
        self.assertNotIn("status", LiteratureSearchItem.model_fields)

        detail = LiteratureDetail(
            literature=literature,
            meta_literature=MetaLiterature(
                meta_literature_id=MetaLiteratureId(_ID_2),
                representative_literature_id=LiteratureId(_ID),
            ),
            metadata_revision=2,
            metadata_sha256=Sha256(_HASH),
            missing_step="parser-result",
            needs_manual_pdf=False,
            metadata_observations=(_observation(),),
            primary_pdf=_asset_view(),
            additional_assets=(),
            parser_result=_parser_result(),
            content=_content(),
            other_versions=(),
            reference_count=1,
            cited_by_count=0,
        )
        self.assertEqual(LiteratureDetail.model_validate_json(detail.model_dump_json()), detail)
        with self.assertRaises(ValidationError):
            LiteratureDetail(**{**detail.model_dump(), "pdf_bytes": b"%PDF"})
        with self.assertRaises(ValidationError):
            LiteratureDetail(**{**detail.model_dump(), "output_path": "/tmp/out.md"})
        with self.assertRaises(ValidationError):
            LiteratureDetail(**{**detail.model_dump(), "report": {}})
        with self.assertRaises(ValidationError):
            LiteratureDetail(**{**detail.model_dump(), "metadata_revision": 0})

    def test_reference_projection_reuses_reference_and_support_models(self) -> None:
        source = _search_item(literature=_literature(literature_id=_ID))
        target = _search_item(
            literature=_literature(literature_id=_ID_2, meta_literature_id=_ID_3),
            literature_id=_ID_2,
        )
        reference = Reference(
            reference_id=ReferenceId(_ID_3),
            source_literature_id=LiteratureId(_ID),
            target_literature_id=LiteratureId(_ID_2),
        )
        support = ReferenceSupport.model_validate(
            {
                "reference_id": ReferenceId(_ID_3),
                "source": {
                    "kind": "metadata_reference_text",
                    "metadata_observation_id": ObservationId(_ID_4),
                    "reference_index": 0,
                },
            }
        )
        item = LiteratureReferenceItem(
            reference=reference,
            related_literature=target,
            support_count=1,
        )
        page = LiteratureReferencePage(items=(item,), total_count=1)
        detail = ReferenceDetail(
            reference=reference,
            source=source,
            target=target,
            supports=(support,),
        )
        self.assertEqual(LiteratureReferencePage.model_validate_json(page.model_dump_json()), page)
        self.assertEqual(ReferenceDetail.model_validate_json(detail.model_dump_json()), detail)
        with self.assertRaises(ValidationError):
            LiteratureReferenceItem(
                reference=reference,
                related_literature=target,
                support_count=0,
            )
        with self.assertRaises(ValidationError):
            LiteratureReferencePage(items=(item, item), total_count=1)
        with self.assertRaises(ValidationError):
            ReferenceDetail(reference=reference, source=source, target=target, supports=())
        with self.assertRaises(ValidationError):
            ReferenceDetail(
                reference=reference,
                source=target,
                target=source,
                supports=(support,),
            )

    def test_bibliographic_record_reuses_metadata_and_only_keeps_input_index(self) -> None:
        record = BibliographicRecord(record_index=4, metadata=_metadata())
        self.assertIsInstance(record.metadata, LiteratureMetadata)
        self.assertEqual(record.record_index, 4)
        self.assertEqual(BibliographicRecord.model_validate_json(record.model_dump_json()), record)
        self.assertEqual(set(BibliographicRecord.model_fields), {"record_index", "metadata"})
        with self.assertRaises(ValidationError):
            BibliographicRecord(record_index=-1, metadata=_metadata())
        with self.assertRaises(ValidationError):
            BibliographicRecord(
                record_index=0,
                metadata=_metadata(),
                source_path="/absolute/input.bib",  # type: ignore[call-arg]
            )
        with self.assertRaises(ValidationError):
            BibliographicRecord(record_index=0, metadata=_metadata(), raw_bytes=b"raw")  # type: ignore[call-arg]

    def test_query_models_are_strict_frozen_closed_pydantic_models(self) -> None:
        models: tuple[type[BaseModel], ...] = (
            LibraryQuery,
            LibrarySearchRequest,
            LiteratureSearchItem,
            LibrarySearchPage,
            LiteratureAssetView,
            LiteratureDetail,
            LiteratureReferenceRequest,
            LiteratureReferenceItem,
            LiteratureReferencePage,
            ReferenceDetail,
            BibliographicRecord,
        )
        for model in models:
            with self.subTest(model=model.__name__):
                self.assertTrue(model.model_config.get("frozen"))
                self.assertTrue(model.model_config.get("strict"))
                self.assertEqual(model.model_config.get("extra"), "forbid")


if __name__ == "__main__":
    unittest.main()
