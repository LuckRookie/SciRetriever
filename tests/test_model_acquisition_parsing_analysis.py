from __future__ import annotations

import dataclasses
import hashlib
import io
import unittest
from contextlib import AbstractContextManager, closing
from typing import BinaryIO, cast

from pydantic import TypeAdapter, ValidationError

from sciretriever.model.acquisition import (
    AcceptedManualPdf,
    AcquiredPrimaryPdf,
    AcquisitionPath,
    AcquisitionResult,
    Asset,
    AssetHint,
    AssetHintKind,
    AssetRole,
    AutomaticPdfAcquisitionExhaustion,
    LiteratureAsset,
    NoPrimaryPdf,
    PdfCandidate,
)
from sciretriever.model.analysis import (
    ArtifactRef,
    FinalMetadataProposal,
    LiteratureContent,
    LiteratureContentProposal,
    LiteratureSection,
    LiteratureSectionRole,
    LiteratureSubsection,
    NoUsableContent,
    ReferenceLookup,
    analysis_input_sha256,
    content_sha256,
)
from sciretriever.model.literature import Identifier
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.parsing import (
    ParserArtifactRef,
    ParserProvenance,
    ParserRequest,
    ParserResource,
    ParserResult,
    StorageObjectRef,
    parser_result_sha256,
)
from sciretriever.model.primitives import (
    AssetId,
    LiteratureAssetId,
    LiteratureId,
    ProvenanceId,
    RelativeArtifactPath,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance

_ID = "123e4567-e89b-12d3-a456-426614174000"
_ASSET_ID = "123e4567-e89b-12d3-a456-426614174001"
_RELATION_ID = "123e4567-e89b-12d3-a456-426614174002"
_HASH = "a" * 64
_TIMESTAMP = "2026-08-10T12:34:56.123Z"


class ModelContractTests(unittest.TestCase):
    def provenance(
        self,
        kind: SourceKind,
        source_name: str,
        *,
        input_sha256: Sha256 | None = Sha256(_HASH),
        parameters_sha256: Sha256 | None = Sha256(_HASH),
        source_record_id: str | None = None,
    ) -> Provenance:
        return Provenance(
            provenance_id=ProvenanceId(_ID),
            source_kind=kind,
            source_name=source_name,
            source_record_id=source_record_id,
            observed_at=UtcTimestamp(_TIMESTAMP),
            input_sha256=input_sha256,
            parameters_sha256=parameters_sha256,
        )

    def asset(self) -> Asset:
        return Asset(
            asset_id=AssetId(_ASSET_ID),
            sha256=sha256_digest(b"pdf bytes"),
            size_bytes=9,
            media_type="application/pdf",
            path=RelativeArtifactPath("assets/pdf"),
        )

    def relation(self, *, manual: bool = False) -> LiteratureAsset:
        provenance = self.provenance(
            SourceKind.USER if manual else SourceKind.ASSET_PROVIDER,
            "manual-pdf" if manual else "crossref",
            input_sha256=sha256_digest(b"pdf bytes") if manual else Sha256(_HASH),
        )
        return LiteratureAsset(
            literature_asset_id=LiteratureAssetId(_RELATION_ID),
            literature_id=LiteratureId(_ID),
            asset_id=AssetId(_ASSET_ID),
            role=AssetRole.PRIMARY_PDF,
            provenance=provenance,
            source_url=None if manual else "https://example.invalid/article.pdf",
        )

    def metadata(self) -> LiteratureMetadata:
        return LiteratureMetadata(
            title="A target paper",
            authors=(),
            abstract=None,
            publication_date=None,
            publication_year=2026,
            document_type="article",
            language="en",
            venue="Journal",
            publisher="Publisher",
            volume=None,
            issue=None,
            pages=None,
            identifiers=(Identifier(namespace="doi", value="10.1234/example"),),
            keywords=("testing",),
        )

    def parser_result(self) -> ParserResult:
        source_sha = sha256_digest(b"pdf bytes")
        parser_provenance = ParserProvenance(
            provenance=self.provenance(
                SourceKind.PARSER,
                "fixture-parser",
                input_sha256=source_sha,
            ),
            parser_version="1.0",
            mode=None,
            model_identity=None,
        )
        markdown = ParserArtifactRef(
            sha256=sha256_digest("# body".encode()),
            media_type="text/markdown",
            byte_size=6,
        )
        resources = (
            ParserResource(
                reference="images/figure.png",
                artifact=ParserArtifactRef(
                    sha256=Sha256("b" * 64),
                    media_type="image/png",
                    byte_size=3,
                ),
            ),
        )
        source_asset_id = AssetId(_ASSET_ID)
        page_count = 1
        return ParserResult(
            source_asset_id=source_asset_id,
            source_sha256=source_sha,
            page_count=page_count,
            markdown=markdown,
            resources=resources,
            provenance=parser_provenance,
            result_sha256=parser_result_sha256(
                source_asset_id=source_asset_id,
                source_sha256=source_sha,
                page_count=page_count,
                markdown=markdown,
                resources=resources,
                provenance=parser_provenance,
            ),
        )

    def sections(self) -> tuple[LiteratureSection, ...]:
        return tuple(
            LiteratureSection(
                role=role,
                title=None,
                markdown="未提供",
                subsections=(),
            )
            for role in (
                LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
                LiteratureSectionRole.METHODS,
                LiteratureSectionRole.DATA,
                LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
            )
        )

    def content(self) -> LiteratureContent:
        metadata_hash = sha256_digest(self.metadata().model_dump_json().encode())
        markdown = ArtifactRef(
            sha256=sha256_digest("# markdown".encode()),
            media_type="text/markdown",
            byte_size=11,
        )
        metadata_revision = 1
        sections = self.sections()
        references: tuple[str, ...] = ()
        provenance = self.provenance(
            SourceKind.ANALYSIS,
            "fixture-model",
            input_sha256=sha256_digest(b"pdf bytes"),
        )
        return LiteratureContent(
            literature_content_sha256=content_sha256(
                metadata_sha256=metadata_hash,
                sections=sections,
                references=references,
            ),
            metadata_revision=metadata_revision,
            metadata_sha256=metadata_hash,
            sections=sections,
            references=references,
            markdown=markdown,
            provenance=provenance,
        )

    def content_proposal(self) -> LiteratureContentProposal:
        parser_result = self.parser_result()
        metadata = self.metadata()
        metadata_hash = sha256_digest(metadata.model_dump_json().encode())
        sections = self.sections()
        references = ("A. Author. Source work.",)
        return LiteratureContentProposal(
            literature_id=LiteratureId(_ID),
            primary_asset_id=parser_result.source_asset_id,
            primary_pdf_sha256=parser_result.source_sha256,
            parser_result_sha256=parser_result.result_sha256,
            input_metadata_revision=1,
            input_metadata_sha256=Sha256("b" * 64),
            final_metadata=metadata,
            metadata_sha256=metadata_hash,
            sections=sections,
            references=references,
            literature_content_sha256=content_sha256(
                metadata_sha256=metadata_hash,
                sections=sections,
                references=references,
            ),
            markdown=ArtifactRef(
                sha256=sha256_digest(b"# final markdown\n"),
                media_type="text/markdown",
                byte_size=len(b"# final markdown\n"),
            ),
            provenance=self.provenance(
                SourceKind.ANALYSIS,
                "fixture-provider/fixture-model",
            ),
        )

    def test_acquisition_result_is_exact_two_way_union(self) -> None:
        asset = self.asset()
        acquired = AcquiredPrimaryPdf(
            asset=asset,
            relation=self.relation(),
            candidate_key="crossref/public/1",
        )
        result_type = TypeAdapter(AcquisitionResult)
        self.assertEqual(result_type.validate_python(acquired), acquired)
        self.assertIsInstance(result_type.validate_python(NoPrimaryPdf()), NoPrimaryPdf)
        with self.assertRaises(ValidationError):
            NoPrimaryPdf(reason="not-found")  # type: ignore[call-arg]

    def test_acquisition_boundaries_do_not_store_urls_on_candidates_or_paths_on_manual(
        self,
    ) -> None:
        hint = AssetHint(
            url="https://example.invalid/article.pdf",
            kind=AssetHintKind.DIRECT_FILE,
            media_type="application/pdf",
            asset_role=AssetRole.PRIMARY_PDF,
        )
        self.assertEqual(hint.kind, AssetHintKind.DIRECT_FILE)
        candidate = PdfCandidate(
            candidate_key="fixture/public/1",
            source_name="fixture",
            acquisition_path=AcquisitionPath.PUBLIC,
            declared_media_type="application/pdf",
        )
        self.assertNotIn("url", PdfCandidate.model_fields)
        accepted = AcceptedManualPdf(asset=self.asset(), relation=self.relation(manual=True))
        self.assertIsNone(accepted.relation.source_url)
        self.assertNotIn("path", AcceptedManualPdf.model_fields)
        self.assertEqual(candidate.acquisition_path, AcquisitionPath.PUBLIC)

        with self.assertRaises(ValidationError):
            PdfCandidate(
                candidate_key="fixture/public/1",
                source_name="fixture",
                acquisition_path=AcquisitionPath.PUBLIC,
                url="https://example.invalid/article.pdf",  # type: ignore[call-arg]
            )
        with self.assertRaises(ValidationError):
            PdfCandidate(
                candidate_key="fixture/public/1",
                source_name="fixture",
                acquisition_path=AcquisitionPath.PUBLIC,
                headers={"Authorization": "Bearer secret"},  # type: ignore[call-arg]
            )
        with self.assertRaises(ValidationError):
            AcceptedManualPdf(
                asset=self.asset(),
                relation=self.relation(manual=True),
                path=RelativeArtifactPath("incoming/paper.pdf"),  # type: ignore[call-arg]
            )

    def test_asset_hints_reject_credential_and_signature_queries_without_echoing_values(
        self,
    ) -> None:
        ordinary = AssetHint(
            url="https://example.invalid/article.pdf?download=1&doi=10.1000%2Ffixture",
            kind=AssetHintKind.DIRECT_FILE,
        )
        self.assertEqual(
            ordinary.url,
            "https://example.invalid/article.pdf?download=1&doi=10.1000%2Ffixture",
        )

        secret = "ASSET-HINT-SECRET-SENTINEL"
        sensitive_urls = (
            f"https://example.invalid/article.pdf?api_key={secret}",
            f"https://example.invalid/article.pdf?API-KEY={secret}",
            f"https://example.invalid/article.pdf?api%5Fkey={secret}",
            f"https://example.invalid/article.pdf?token={secret}",
            f"https://example.invalid/article.pdf?X-Amz-Signature={secret}",
            f"https://example.invalid/article.pdf?X-Goog-Credential={secret}",
            f"https://example.invalid/article.pdf?download=1&refresh-token={secret}",
        )
        for url in sensitive_urls:
            with self.subTest(url=url):
                with self.assertRaises(ValidationError) as caught:
                    AssetHint(url=url, kind=AssetHintKind.DIRECT_FILE)
                self.assertNotIn(secret, str(caught.exception))

                with self.assertRaises(ValidationError) as source_caught:
                    LiteratureAsset.model_validate(
                        {
                            **self.relation().model_dump(),
                            "source_url": url,
                        }
                    )
                self.assertNotIn(secret, str(source_caught.exception))

        with self.assertRaises(ValidationError):
            AssetHint(
                url="https://example.invalid/article.pdf?download=%ZZ",
                kind=AssetHintKind.DIRECT_FILE,
            )

    def test_exhaustion_fact_only_contains_literature_id(self) -> None:
        exhaustion = AutomaticPdfAcquisitionExhaustion(literature_id=LiteratureId(_ID))
        self.assertEqual(exhaustion.literature_id, LiteratureId(_ID))
        self.assertEqual(
            set(AutomaticPdfAcquisitionExhaustion.model_fields),
            {"literature_id"},
        )
        with self.assertRaises(ValidationError):
            AutomaticPdfAcquisitionExhaustion(
                literature_id=LiteratureId(_ID),
                reason="not-found",  # type: ignore[call-arg]
            )

    def test_parser_request_is_pdf_only_path_free_and_capability_backed(self) -> None:
        class ContentRef:
            def __init__(self) -> None:
                self.private_path = "/private/catalog/assets/source.pdf"

            def open(self) -> AbstractContextManager[BinaryIO]:
                return closing(io.BytesIO(b"pdf bytes"))

            def __repr__(self) -> str:
                return f"ContentRef(private_path={self.private_path!r})"

        content_ref = ContentRef()
        request = ParserRequest(
            source_asset_id=AssetId(_ASSET_ID),
            source_sha256=sha256_digest(b"pdf bytes"),
            media_type="application/pdf",
            content_ref=content_ref,
        )

        self.assertEqual(
            tuple(field.name for field in dataclasses.fields(ParserRequest)),
            ("source_asset_id", "source_sha256", "media_type", "content_ref"),
        )
        self.assertIsInstance(content_ref, StorageObjectRef)
        self.assertIs(request.content_ref, content_ref)
        self.assertFalse(hasattr(request, "path"))
        self.assertNotIn(content_ref.private_path, repr(request))

        invalid_values = (
            {"media_type": "text/html"},
            {"media_type": "application/pdf; charset=binary"},
            {"content_ref": content_ref.private_path},
            {"source_asset_id": _ASSET_ID},
            {"source_sha256": _HASH},
        )
        for update in invalid_values:
            with self.subTest(update=update), self.assertRaises((TypeError, ValueError)):
                ParserRequest(
                    source_asset_id=update.get("source_asset_id", AssetId(_ASSET_ID)),  # type: ignore[arg-type]
                    source_sha256=update.get(  # type: ignore[arg-type]
                        "source_sha256",
                        sha256_digest(b"pdf bytes"),
                    ),
                    media_type=update.get("media_type", "application/pdf"),  # type: ignore[arg-type]
                    content_ref=cast(
                        StorageObjectRef,
                        update.get("content_ref", content_ref),
                    ),
                )

        with self.assertRaises(TypeError):
            ParserRequest(
                source_asset_id=AssetId(_ASSET_ID),
                source_sha256=sha256_digest(b"pdf bytes"),
                media_type="application/pdf",
                content_ref=content_ref,
                path="assets/source.pdf",  # type: ignore[call-arg]
            )

    def test_parser_resource_is_sorted_unique_and_safe_relative_reference(self) -> None:
        parser_result = self.parser_result()
        self.assertEqual(
            tuple(resource.reference for resource in parser_result.resources),
            ("images/figure.png",),
        )
        with self.assertRaises(ValidationError):
            ParserResource(reference="../secret.txt", artifact=parser_result.resources[0].artifact)
        with self.assertRaises(ValidationError):
            ParserResource(
                reference="https://example.invalid/a",
                artifact=parser_result.resources[0].artifact,
            )
        with self.assertRaises(ValidationError):
            ParserResource(
                reference="images\\figure.png",
                artifact=parser_result.resources[0].artifact,
            )

        with self.assertRaises(ValidationError):
            ParserResult(
                **{
                    **parser_result.model_dump(),
                    "resources": (
                        parser_result.resources[0],
                        parser_result.resources[0],
                    ),
                },
            )

    def test_parser_result_rejects_private_task_fields_and_wrong_hash(self) -> None:
        parser_result = self.parser_result()
        for private_field in ("task", "block", "bbox"):
            with self.subTest(private_field=private_field), self.assertRaises(ValidationError):
                ParserResult(
                    **{
                        **parser_result.model_dump(),
                        private_field: "private parser detail",
                    },
                )

        with self.assertRaises(ValidationError):
            ParserResult.model_validate(
                {
                    **parser_result.model_dump(),
                    "result_sha256": Sha256("f" * 64),
                }
            )

    def test_parser_provenance_identities_reject_machine_paths_before_hashing(
        self,
    ) -> None:
        parser_result = self.parser_result()
        base = parser_result.provenance
        invalid_identities = (
            "../private/model.bin",
            "./model",
            ".",
            "..",
            "organization/./model",
            "organization/../model",
            "organization//model",
            r"dir\model.bin",
            r"C:\private\model.bin",
            r"C:private\model.bin",
            "C:/private/model.bin",
            "~/model",
            "/absolute/model",
            "https://host/model",
            " model",
            "model ",
            "model\x00identity",
            "model\nidentity",
            "model\x85identity",
        )
        valid_fields = {
            "parser_version": "3.4.4",
            "mode": "vlm-engine",
            "model_identity": "organization/model@revision",
        }

        for field in valid_fields:
            for identity in invalid_identities:
                with self.subTest(field=field, identity=identity):
                    payload = {"provenance": base.provenance, **valid_fields}
                    payload[field] = identity
                    with self.assertRaises(ValidationError) as caught:
                        ParserProvenance.model_validate(payload)
                    if identity == "../private/model.bin":
                        self.assertNotIn(identity, str(caught.exception))
                        self.assertNotIn(identity, repr(caught.exception))

        legal = ParserProvenance(
            provenance=base.provenance,
            parser_version="3.4.4",
            mode="vlm-engine",
            model_identity="organization/model@revision",
        )
        alternate_model = ParserProvenance(
            provenance=base.provenance,
            parser_version="3.4.4",
            mode="vlm-engine",
            model_identity="operator-model@sha256-deadbeef",
        )
        self.assertEqual(legal.parser_version, "3.4.4")
        self.assertEqual(legal.mode, "vlm-engine")
        self.assertEqual(legal.model_identity, "organization/model@revision")
        self.assertEqual(
            alternate_model.model_identity,
            "operator-model@sha256-deadbeef",
        )

        for field in valid_fields:
            forged = base.model_copy(update={field: "../private/model.bin"})
            with self.subTest(hash_field=field), self.assertRaises(ValidationError):
                parser_result_sha256(
                    source_asset_id=parser_result.source_asset_id,
                    source_sha256=parser_result.source_sha256,
                    page_count=parser_result.page_count,
                    markdown=parser_result.markdown,
                    resources=parser_result.resources,
                    provenance=forged,
                )

    def test_parser_result_hash_matches_adr_0010_golden_and_field_mutations(self) -> None:
        canonical_json = (
            '{"markdown":{"byte_size":123,"media_type":"text/markdown",'
            '"sha256":"2222222222222222222222222222222222222222222222222222222222222222"},'
            '"page_count":7,"parser":{"mode":"vlm","model_identity":"vlm-model-v1",'
            '"name":"mineru",'
            '"parameters_sha256":"5555555555555555555555555555555555555555555555555555555555555555",'
            '"version":"3.4.4"},"resources":[{"artifact":{"byte_size":22,'
            '"media_type":"image/png",'
            '"sha256":"3333333333333333333333333333333333333333333333333333333333333333"},'
            '"reference":"images/figure.png"},{"artifact":{"byte_size":11,'
            '"media_type":"text/csv",'
            '"sha256":"4444444444444444444444444444444444444444444444444444444444444444"},'
            '"reference":"z/tables/data.csv"}],'
            '"source_asset_id":"123e4567-e89b-12d3-a456-426614174011",'
            '"source_sha256":"1111111111111111111111111111111111111111111111111111111111111111"}'
        )
        golden = Sha256("5ad545ac5a6ce598bcc1099d12fe40508733078c1ee9fa0d8454f32809a8a206")
        self.assertEqual(hashlib.sha256(canonical_json.encode("utf-8")).hexdigest(), golden.root)

        source_asset_id = AssetId("123e4567-e89b-12d3-a456-426614174011")
        source_sha256 = Sha256("1" * 64)
        markdown = ParserArtifactRef(
            sha256=Sha256("2" * 64),
            media_type="text/markdown",
            byte_size=123,
        )
        image_resource = ParserResource(
            reference="images/figure.png",
            artifact=ParserArtifactRef(
                sha256=Sha256("3" * 64),
                media_type="image/png",
                byte_size=22,
            ),
        )
        table_resource = ParserResource(
            reference="z/tables/data.csv",
            artifact=ParserArtifactRef(
                sha256=Sha256("4" * 64),
                media_type="text/csv",
                byte_size=11,
            ),
        )
        resources = (table_resource, image_resource)
        parser_provenance = ParserProvenance(
            provenance=Provenance(
                provenance_id=ProvenanceId("123e4567-e89b-12d3-a456-426614174021"),
                source_kind=SourceKind.PARSER,
                source_name="mineru",
                source_record_id=None,
                observed_at=UtcTimestamp("2026-08-12T01:02:03Z"),
                input_sha256=source_sha256,
                parameters_sha256=Sha256("5" * 64),
            ),
            parser_version="3.4.4",
            mode="vlm",
            model_identity="vlm-model-v1",
        )

        def changed_provenance(
            *,
            provenance_id: ProvenanceId | None = None,
            observed_at: UtcTimestamp | None = None,
            source_name: str | None = None,
            input_sha256: Sha256 | None = None,
            parameters_sha256: Sha256 | None = None,
            parser_version: str | None = None,
            mode: str | None = None,
            model_identity: str | None = None,
        ) -> ParserProvenance:
            base = parser_provenance.provenance
            return ParserProvenance(
                provenance=Provenance(
                    provenance_id=base.provenance_id if provenance_id is None else provenance_id,
                    source_kind=SourceKind.PARSER,
                    source_name=base.source_name if source_name is None else source_name,
                    source_record_id=None,
                    observed_at=base.observed_at if observed_at is None else observed_at,
                    input_sha256=base.input_sha256 if input_sha256 is None else input_sha256,
                    parameters_sha256=(
                        base.parameters_sha256 if parameters_sha256 is None else parameters_sha256
                    ),
                ),
                parser_version=(
                    parser_provenance.parser_version if parser_version is None else parser_version
                ),
                mode=parser_provenance.mode if mode is None else mode,
                model_identity=(
                    parser_provenance.model_identity if model_identity is None else model_identity
                ),
            )

        def result_hash(
            *,
            asset_id: AssetId = source_asset_id,
            source_hash: Sha256 = source_sha256,
            pages: int = 7,
            markdown_ref: ParserArtifactRef = markdown,
            resource_refs: tuple[ParserResource, ...] = resources,
            provenance: ParserProvenance = parser_provenance,
        ) -> Sha256:
            return parser_result_sha256(
                source_asset_id=asset_id,
                source_sha256=source_hash,
                page_count=pages,
                markdown=markdown_ref,
                resources=resource_refs,
                provenance=provenance,
            )

        self.assertEqual(result_hash(), golden)
        self.assertEqual(
            result_hash(resource_refs=(image_resource, table_resource)),
            golden,
            "resource tuple order must not affect the reference-sorted manifest",
        )

        changed_source_hash = Sha256("6" * 64)
        mutations = {
            "source_asset_id": result_hash(
                asset_id=AssetId("123e4567-e89b-12d3-a456-426614174012")
            ),
            "source_sha256": result_hash(
                source_hash=changed_source_hash,
                provenance=changed_provenance(input_sha256=changed_source_hash),
            ),
            "page_count": result_hash(pages=8),
            "markdown_sha256": result_hash(
                markdown_ref=markdown.model_copy(update={"sha256": Sha256("7" * 64)})
            ),
            "markdown_media_type": result_hash(
                markdown_ref=markdown.model_copy(update={"media_type": "text/plain"})
            ),
            "markdown_byte_size": result_hash(
                markdown_ref=markdown.model_copy(update={"byte_size": 124})
            ),
            "resource_reference": result_hash(
                resource_refs=(
                    table_resource,
                    image_resource.model_copy(update={"reference": "images/figure-2.png"}),
                )
            ),
            "resource_sha256": result_hash(
                resource_refs=(
                    table_resource,
                    image_resource.model_copy(
                        update={
                            "artifact": image_resource.artifact.model_copy(
                                update={"sha256": Sha256("8" * 64)}
                            )
                        }
                    ),
                )
            ),
            "resource_media_type": result_hash(
                resource_refs=(
                    table_resource,
                    image_resource.model_copy(
                        update={
                            "artifact": image_resource.artifact.model_copy(
                                update={"media_type": "image/webp"}
                            )
                        }
                    ),
                )
            ),
            "resource_byte_size": result_hash(
                resource_refs=(
                    table_resource,
                    image_resource.model_copy(
                        update={
                            "artifact": image_resource.artifact.model_copy(update={"byte_size": 23})
                        }
                    ),
                )
            ),
            "parser_name": result_hash(
                provenance=changed_provenance(source_name="mineru-enterprise")
            ),
            "parser_version": result_hash(provenance=changed_provenance(parser_version="3.4.5")),
            "parser_mode": result_hash(provenance=changed_provenance(mode="pipeline")),
            "parser_model_identity": result_hash(
                provenance=changed_provenance(model_identity="vlm-model-v2")
            ),
            "parser_parameters_sha256": result_hash(
                provenance=changed_provenance(parameters_sha256=Sha256("9" * 64))
            ),
        }
        for field, mutated_hash in mutations.items():
            with self.subTest(field=field):
                self.assertNotEqual(mutated_hash, golden)

        self.assertEqual(
            result_hash(
                provenance=changed_provenance(observed_at=UtcTimestamp("2026-08-12T02:03:04Z"))
            ),
            golden,
        )
        self.assertEqual(
            result_hash(
                provenance=changed_provenance(
                    provenance_id=ProvenanceId("123e4567-e89b-12d3-a456-426614174022")
                )
            ),
            golden,
        )

        for invalid_provenance in (
            Provenance(
                provenance_id=parser_provenance.provenance.provenance_id,
                source_kind=SourceKind.PARSER,
                source_name="mineru",
                source_record_id="private-task-id",
                observed_at=parser_provenance.provenance.observed_at,
                input_sha256=source_sha256,
                parameters_sha256=Sha256("5" * 64),
            ),
            Provenance(
                provenance_id=parser_provenance.provenance.provenance_id,
                source_kind=SourceKind.PARSER,
                source_name="mineru",
                source_record_id=None,
                observed_at=parser_provenance.provenance.observed_at,
                input_sha256=source_sha256,
                parameters_sha256=None,
            ),
        ):
            with self.subTest(invalid_provenance=invalid_provenance):
                with self.assertRaises(ValidationError):
                    ParserProvenance(
                        provenance=invalid_provenance,
                        parser_version="3.4.4",
                        mode="vlm",
                        model_identity="vlm-model-v1",
                    )

    def test_parser_provenance_kind_and_input_hash_are_fixed(self) -> None:
        parser_result = self.parser_result()
        self.assertEqual(parser_result.provenance.provenance.source_kind, SourceKind.PARSER)
        with self.assertRaises(ValidationError):
            ParserResult.model_validate(
                {
                    **parser_result.model_dump(),
                    "provenance": {
                        **parser_result.provenance.model_dump(),
                        "provenance": {
                            **parser_result.provenance.provenance.model_dump(),
                            "source_kind": SourceKind.ANALYSIS,
                        },
                    },
                }
            )

    def test_analysis_provenance_is_kind_fixed_and_has_no_record_identity(self) -> None:
        content = self.content()
        for provenance_update in (
            {"source_kind": SourceKind.PARSER},
            {"source_record_id": "analysis-task-1"},
        ):
            with (
                self.subTest(provenance_update=provenance_update),
                self.assertRaises(ValidationError),
            ):
                LiteratureContent.model_validate(
                    {
                        **content.model_dump(),
                        "provenance": {
                            **content.provenance.model_dump(),
                            **provenance_update,
                        },
                    }
                )

    def test_analysis_result_and_content_are_immutable_and_hash_aligned(self) -> None:
        no_content = NoUsableContent(outcome="no_usable_content")
        proposal = FinalMetadataProposal(outcome="usable", metadata=self.metadata())
        self.assertEqual(no_content.outcome, "no_usable_content")
        self.assertEqual(proposal.metadata, self.metadata())
        content = self.content()
        self.assertEqual(
            content.literature_content_sha256,
            content_sha256(
                metadata_sha256=content.metadata_sha256,
                sections=content.sections,
                references=content.references,
            ),
        )
        with self.assertRaises(ValidationError):
            content.references = ("changed",)  # type: ignore[misc]
        with self.assertRaises(TypeError):
            content_sha256(
                metadata_sha256=content.metadata_sha256,
                sections=content.sections,
                references=content.references,
                unexpected=True,  # type: ignore[call-arg]
            )

        with self.assertRaises(ValidationError):
            NoUsableContent(
                outcome="no_usable_content",
                confidence=0.1,  # type: ignore[call-arg]
            )
        with self.assertRaises(ValidationError):
            NoUsableContent(
                outcome="no_usable_content",
                reason="not enough content",  # type: ignore[call-arg]
            )

    def test_content_proposal_is_temporary_complete_and_revision_free(self) -> None:
        proposal = self.content_proposal()
        self.assertEqual(
            set(LiteratureContentProposal.model_fields),
            {
                "literature_id",
                "primary_asset_id",
                "primary_pdf_sha256",
                "parser_result_sha256",
                "input_metadata_revision",
                "input_metadata_sha256",
                "final_metadata",
                "metadata_sha256",
                "sections",
                "references",
                "literature_content_sha256",
                "markdown",
                "provenance",
            },
        )
        self.assertNotIn("metadata_revision", LiteratureContentProposal.model_fields)
        self.assertNotIn("content", LiteratureContentProposal.model_fields)
        self.assertNotIn("metadata_proposal", LiteratureContentProposal.model_fields)
        self.assertEqual(proposal.final_metadata, self.metadata())
        with self.assertRaises(ValidationError):
            LiteratureContentProposal.model_validate(
                {
                    **proposal.model_dump(),
                    "literature_content_sha256": Sha256("f" * 64),
                }
            )
        with self.assertRaises(ValidationError):
            LiteratureContentProposal.model_validate(
                {
                    **proposal.model_dump(),
                    "provenance": {
                        **proposal.provenance.model_dump(),
                        "source_kind": SourceKind.PARSER,
                    },
                }
            )
        with self.assertRaises(ValidationError):
            LiteratureContentProposal.model_validate(
                {
                    **proposal.model_dump(),
                    "metadata_revision": 2,
                }
            )

    def test_analysis_input_hash_has_one_neutral_tagged_canonical_algorithm(self) -> None:
        self.assertEqual(
            analysis_input_sha256(
                Sha256("1" * 64),
                Sha256("2" * 64),
                Sha256("3" * 64),
            ),
            Sha256("62713f4913361f1bec82a961acadd9906513d5330b996ddf47a389b767d80dfe"),
        )
        with self.assertRaises(TypeError):
            analysis_input_sha256(
                "1" * 64,  # type: ignore[arg-type]
                Sha256("2" * 64),
                Sha256("3" * 64),
            )

    def test_sections_have_four_fixed_roles_in_order_and_reject_conflicts(self) -> None:
        content = self.content()
        self.assertEqual(
            tuple(section.role for section in content.sections),
            (
                LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
                LiteratureSectionRole.METHODS,
                LiteratureSectionRole.DATA,
                LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
            ),
        )
        with self.assertRaises(ValidationError):
            LiteratureContent.model_validate(
                {
                    **content.model_dump(),
                    "sections": (
                        LiteratureSection(
                            role=LiteratureSectionRole.METHODS,
                            title=None,
                            markdown="未提供",
                            subsections=(),
                        ),
                        *content.sections[1:],
                    ),
                }
            )
        with self.assertRaises(ValidationError):
            LiteratureSection(
                role=LiteratureSectionRole.ADDITIONAL,
                title="研究方法",
                markdown="additional",
                subsections=(),
            )
        with self.assertRaises(ValidationError):
            LiteratureSubsection(title="x", markdown="")

        spaced_missing = (
            LiteratureSection(
                role=LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
                title=None,
                markdown=" 未提供 ",
                subsections=(),
            ),
            *content.sections[1:],
        )
        with self.assertRaises(ValidationError):
            LiteratureContent.model_validate(
                {
                    **content.model_dump(),
                    "sections": spaced_missing,
                    "literature_content_sha256": content_sha256(
                        metadata_sha256=content.metadata_sha256,
                        sections=spaced_missing,
                        references=content.references,
                    ),
                }
            )

    def test_missing_reference_marker_is_not_a_reference(self) -> None:
        with self.assertRaises(ValidationError):
            LiteratureContent.model_validate(
                {
                    **self.content().model_dump(),
                    "references": ("未提供",),
                }
            )
        lookup = ReferenceLookup(
            reference_index=0,
            identifiers=(Identifier(namespace="doi", value="10.1234/example"),),
            title=None,
            authors=(),
            publication_year=None,
        )
        self.assertEqual(lookup.reference_index, 0)


if __name__ == "__main__":
    unittest.main()
